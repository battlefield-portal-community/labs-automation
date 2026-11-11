/**
 * Mints the admin session token the automations use, through Kaneo's device
 * authorization flow (client `kaneo-cli`, allowed by default).
 *
 *   KANEO_API_URL=https://yourdomain.com/api node src/cli/device-auth.ts ./secrets/kaneo_admin_token
 *   KANEO_API_URL=http://kaneo:5173/api node src/cli/device-auth.ts --env   # paste into Portainer
 *
 * The approving account needs `users:read` and `workspaces:manage` — in practice
 * an instance administrator. Re-run only when the listener has been offline for
 * longer than the session lifetime (~7 days), or after the session is revoked.
 */
import { writeFileSync } from "node:fs";

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export async function mintToken(options: {
  apiUrl: string;
  clientId: string;
  onPrompt: (prompt: { userCode: string; verificationUri: string; expiresIn?: number }) => void;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}): Promise<{ token: string; expiresIn?: number }> {
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const codeResponse = await fetch(`${apiUrl}/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: options.clientId }),
  });

  const code = (await codeResponse.json()) as DeviceCodeResponse;
  if (!codeResponse.ok || !code.device_code) {
    throw new Error(`device code request failed: ${codeResponse.status} ${JSON.stringify(code)}`);
  }

  options.onPrompt({
    userCode: code.user_code,
    verificationUri: code.verification_uri_complete ?? code.verification_uri ?? "",
    ...(code.expires_in === undefined ? {} : { expiresIn: code.expires_in }),
  });

  let waitMs = options.pollIntervalMs ?? Math.max(1, code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 600) * 1000;

  for (;;) {
    if (Date.now() > deadline) throw new Error("device code expired; run the command again");
    await sleep(waitMs);

    const tokenResponse = await fetch(`${apiUrl}/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: GRANT_TYPE,
        device_code: code.device_code,
        client_id: options.clientId,
      }),
    });

    const token = (await tokenResponse.json()) as TokenResponse;

    if (tokenResponse.ok && token.access_token) {
      return {
        token: token.access_token,
        ...(token.expires_in === undefined ? {} : { expiresIn: token.expires_in }),
      };
    }

    if (token.error === "authorization_pending") continue;
    if (token.error === "slow_down") {
      waitMs += 5000;
      continue;
    }

    throw new Error(
      `token exchange failed: ${tokenResponse.status} ${token.error ?? ""} ${token.error_description ?? ""}`.trim(),
    );
  }
}

async function main(): Promise<void> {
  const apiUrl = process.env.KANEO_API_URL ?? "http://localhost:5173/api";
  const clientId = process.env.KANEO_DEVICE_CLIENT_ID ?? "kaneo-cli";
  const outPath = process.argv[2];

  const { token, expiresIn } = await mintToken({
    apiUrl,
    clientId,
    onPrompt: ({ userCode, verificationUri, expiresIn: lifetime }) => {
      console.log(`\nAPI:        ${apiUrl}`);
      console.log(`Open:       ${verificationUri}`);
      console.log(`Code:       ${userCode}`);
      console.log(`Valid for:  ${lifetime ?? "?"}s`);
      console.log("\nSign in as the admin account, approve the device, then come back here.\n");
    },
  });

  if (outPath === "--env") {
    // For pasting into a Portainer stack's environment variables.
    console.log(`\nKANEO_ADMIN_TOKEN=${token}\n`);
  } else if (outPath) {
    writeFileSync(outPath, `${token}\n`, { mode: 0o600 });
    console.log(`Token written to ${outPath} (mode 600).`);
  } else {
    console.log(`Token:\n${token}`);
  }

  console.log(
    `Session lifetime: ${expiresIn ?? "?"}s. It slides forward while the automations keep making\n` +
      "requests, so an idle Kaneo instance is fine; only a stopped sidecar needs a re-run.\n",
  );
}

const invokedDirectly = process.argv[1]?.endsWith("device-auth.ts") ?? false;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
