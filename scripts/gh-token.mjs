#!/usr/bin/env node
// Mints a short-lived installation token for the glade-team GitHub App, so kittens (worker agents) act on GitHub as
// glade-team rather than as Jared. Prints only the token to stdout; use it inline, one token per call:
//
//   GH_TOKEN="$(node scripts/gh-token.mjs)" gh pr create ...
//
// Config lives outside the repo in ~/.config/glade-team/config.json (override with GLADE_TEAM_CONFIG):
//   { "appId": 123, "installationId": 456, "privateKeyPath": "/absolute/path/to/private-key.pem" }
// Dependency-free (Node stdlib only). Never prints the key or the token anywhere but stdout.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function fail(message) {
  process.stderr.write(`gh-token: ${message}\n`);
  process.exit(1);
}

const base64url = (data) => Buffer.from(data).toString("base64url");

const configPath = process.env.GLADE_TEAM_CONFIG || join(homedir(), ".config", "glade-team", "config.json");

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  fail(`cannot read config at ${configPath} (${error.code ?? error.name})`);
}
const { appId, installationId, privateKeyPath } = config;
if (!appId || !installationId || !privateKeyPath) {
  fail(`config at ${configPath} needs appId, installationId and privateKeyPath`);
}

let privateKey;
try {
  privateKey = readFileSync(privateKeyPath, "utf8");
} catch (error) {
  fail(`cannot read private key at ${privateKeyPath} (${error.code ?? error.name})`);
}

const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
let jwt;
try {
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey, "base64url");
  jwt = `${header}.${payload}.${signature}`;
} catch {
  fail(`cannot sign the JWT with the key at ${privateKeyPath}`);
}

let response;
try {
  response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
} catch (error) {
  fail(`request to GitHub failed (${error.cause?.code ?? error.name})`);
}

const body = await response.json().catch(() => ({}));
if (!response.ok || typeof body.token !== "string") {
  fail(`GitHub returned ${response.status}: ${body.message ?? "no token in response"}`);
}
process.stdout.write(body.token);
