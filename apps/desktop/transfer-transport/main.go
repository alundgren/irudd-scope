package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
)

const maxRequest = 16 * 1024
const maxResponse = 64 * 1024 * 1024

var addressPattern = regexp.MustCompile(`^tc[A-Za-z0-9_-]+$`)

type operation struct {
	Mode    string `json:"mode"`
	Port    int    `json:"port,omitempty"`
	Address string `json:"address,omitempty"`
	Body    string `json:"body,omitempty"`
}

func main() {
	log.SetOutput(io.Discard)
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		info, ok := debug.ReadBuildInfo()
		if ok {
			for _, dependency := range info.Deps {
				if dependency.Path == "github.com/tailscale/tailcat" && dependency.Replace == nil {
					fmt.Println("scope-tailcat tailcat/" + dependency.Version)
					return
				}
			}
		}
		os.Exit(1)
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Scope transfer transport failed.")
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 1 {
		return errors.New("arguments")
	}
	input := bufio.NewReaderSize(os.Stdin, 64*1024)
	line, err := input.ReadSlice('\n')
	if err != nil {
		return err
	}
	var op operation
	decoder := json.NewDecoder(strings.NewReader(string(line)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&op); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("extra input")
	}
	switch op.Mode {
	case "listen":
		if op.Port < 1 || op.Port > 65535 || op.Address != "" || op.Body != "" {
			return errors.New("invalid listener")
		}
		return listen(input, op.Port)
	case "request":
		if op.Port != 0 || len(op.Body) > maxRequest || len(op.Address) < 40 || len(op.Address) > 4096 || !addressPattern.MatchString(op.Address) {
			return errors.New("invalid request")
		}
		if _, err := tailcat.ParseAddr(tailcat.Addr(op.Address)); err != nil {
			return err
		}
		return request(op)
	default:
		return errors.New("invalid mode")
	}
}

func request(op operation) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client := tailcat.NewClient(tailcat.Addr(op.Address))
	client.Logf = func(string, ...any) {}
	defer client.Close()
	transport := &http.Transport{DisableKeepAlives: true, ResponseHeaderTimeout: 30 * time.Second, MaxResponseHeaderBytes: 8192,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return client.DialTCPPort(ctx, 80) },
	}
	defer transport.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://scope/", strings.NewReader(op.Body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("request rejected")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil {
		return err
	}
	if len(body) > maxResponse {
		return errors.New("response too large")
	}
	_, err = os.Stdout.Write(body)
	return err
}

func listen(input io.Reader, port int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	server := &tailcat.Server{Logf: func(string, ...any) {}}
	defer server.Close()
	listener, err := server.Listen(ctx, "tcp", ":80")
	if err != nil {
		return err
	}
	defer listener.Close()
	var mu sync.Mutex
	active := map[net.Conn]bool{}
	closed := false
	done := make(chan struct{})
	go func() {
		io.Copy(io.Discard, input)
		mu.Lock()
		closed = true
		for connection := range active {
			connection.Close()
		}
		mu.Unlock()
		close(done)
		listener.Close()
	}()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"address": string(server.TailcatAddr())}); err != nil {
		return err
	}
	for {
		remote, err := listener.Accept()
		if err != nil {
			select {
			case <-done:
				return nil
			default:
				return err
			}
		}
		mu.Lock()
		if closed || len(active) >= 4 {
			mu.Unlock()
			remote.Close()
			continue
		}
		active[remote] = true
		mu.Unlock()
		go func() {
			defer func() { remote.Close(); mu.Lock(); delete(active, remote); mu.Unlock() }()
			remote.SetDeadline(time.Now().Add(60 * time.Second))
			local, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 10*time.Second)
			if err != nil {
				return
			}
			defer local.Close()
			local.SetDeadline(time.Now().Add(60 * time.Second))
			copied := make(chan struct{})
			go func() { io.Copy(local, remote); local.Close(); close(copied) }()
			io.Copy(remote, local)
			remote.Close()
			local.Close()
			<-copied
		}()
	}
}
