import html from "./starter.html?raw";
import tokens from "../../renderer/tokens.css?raw";
export const starterPullRequestsHTML = html.replaceAll("/* SCOPE_TOKENS */", tokens);
