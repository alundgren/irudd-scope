# Conversational podcast delivery

Use solo style C or two-speaker style E. Aoede is the solo narrator and the
conversation lead. Leda is the second speaker, not an automatic replacement
after a failed generation. `irudd-scope voice guide` returns the canonical
instructions under `styles.solo` and `styles.conversation`.

## Write the script

Write as a developer talking to someone familiar during an ongoing discussion.
Start with the actual point. Use contractions, varied sentence lengths, and
occasional corrections or asides where the thought calls for them. Let some
phrases run together and leave a question room to land. Keep the amount of
hesitation small; random filler and stage directions quickly become mannerisms.

For daily news, select what matters and explain the practical consequence.
Separate reported facts from your interpretation and uncertainty. Put sources
and dates in accompanying notes; do not invent personal experience. Optimism,
skepticism, surprise, and concern should follow the evidence. The delivery stays
restrained even when the speakers like an announcement. Avoid an obligatory
welcome, dramatic hooks, and a conclusion that wraps up each short segment.

For E, write complete conversational turns. The second speaker can question an
assumption, add a concrete example, or ask what a claim means in practice. The
lead should respond to that contribution. Do not divide one article into two
alternating reads or make every response an agreement. Avoid scripted overlap:
this path generates each turn separately and cannot hear the previous audio.

## Solo C

Write verbatim speech to `solo.txt`, record a unique ID, and generate:

```sh
irudd-scope voice generate solo.txt --request-id podcast-unique-solo \
  --output solo.wav --receipt solo.receipt.json
```

Omitted settings select Aoede and C. When adding content-specific delivery notes,
keep `styles.solo.instructions` and append the notes; explicit instructions
replace the default rather than extending it.

## Conversation E

Keep the script as ordered turns with stable speaker roles and source notes.
Save each turn's text separately and record a unique request ID per turn before
calling. Read `voice guide` once. Pass `styles.conversation.primary.instructions`
as `--instructions` for Aoede and `styles.conversation.secondary.instructions`
for Leda. For example, with those strings held in shell variables:

```sh
irudd-scope voice generate turn-01.txt --request-id podcast-unique-01 \
  --voice Aoede --instructions "$primary_instructions" \
  --output turn-01.wav --receipt turn-01.receipt.json
irudd-scope voice generate turn-02.txt --request-id podcast-unique-02 \
  --voice Leda --instructions "$secondary_instructions" \
  --output turn-02.wav --receipt turn-02.receipt.json
```

Join all exported turns in script order with the skill's helper:

```sh
python3 /absolute/path/to/irudd-scope/scripts/join-wav.py conversation.wav \
  turn-01.wav turn-02.wav
```

The helper inserts 180 ms silence between turns, preserves generated pauses,
requires Scope's 24 kHz mono 16-bit PCM WAVs, and refuses to overwrite the output.
It performs no provider calls, normalization, music mixing, or tempo adjustment.

## Recovery, length, and publication

Recover uncertain turns with the same request ID using `voice status` and
`voice result`. Never silently switch voices, regenerate a failed turn, or
choose new IDs after uncertainty. Save receipts and actual costs per turn;
unknown cost stays null. Keep scripts and instructions alongside exports.

Scope retains at most 16 requests for 24 hours, including completed requests.
Do not plan an hour-long show with dozens of turn requests through this API.
An assistant's daily podcast pipeline can use the same provider settings with
its own durable request tracking; Scope's normal artifact publication can still
display the result. Scope narration itself is capped at 16 KiB UTF-8 per request.
Split scripts at complete thoughts when limits require it; use consistent roles
and instructions across chunks. Do not squeeze a show into arbitrary short
turns just to alternate speakers.

To listen in Scope, publish an HTML page with embedded audio, transcript, sources,
and download controls. Adjacent audio files are not uploaded with HTML. Keep the
artifact below 32 MiB; larger full episodes need an accessible audio URL or a
smaller listening sample. Keep request IDs, receipts, and WAV exports locally
before their 24-hour expiry.
