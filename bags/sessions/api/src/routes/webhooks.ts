import { Router, Request, Response } from "express";
import crypto from "crypto";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { createLogger } from "@barry-rocks/sdk/logging";

const log = createLogger("barry-server");
export function createWebhooksRouter(options: {
  readSigningKey?: () => Promise<string | undefined>;
  maxAgeSeconds?: number;
  now?: () => number;
} = {}) {
  const router = Router();
  const readSigningKey = options.readSigningKey ?? (async () =>
    (await installationSecrets(["MAILGUN_SIGNING_KEY"], { optionalNames: ["MAILGUN_SIGNING_KEY"] })).MAILGUN_SIGNING_KEY);
  const maxAgeSeconds = options.maxAgeSeconds ?? Number(process.env.MAILGUN_MAX_AGE_SECONDS ?? "300");
  const now = options.now ?? Date.now;

  async function verifyMailgunSignature(timestamp: string, token: string, signature: string): Promise<boolean> {
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error("invalid webhook freshness configuration");
    const key = await readSigningKey();
    if (!key) return false;
    const parsedTimestamp = Number(timestamp);
    if (!Number.isSafeInteger(parsedTimestamp) || Math.abs(Math.floor(now() / 1000) - parsedTimestamp) > maxAgeSeconds) return false;
    const expected = crypto.createHmac("sha256", key).update(timestamp + token).digest();
    const received = Buffer.from(signature, "hex");
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  }

  router.post("/mailgun/incoming", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const { timestamp, token, signature } = body;

    if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp) || typeof token !== "string" || !token || typeof signature !== "string" || !/^[a-f\d]{64}$/i.test(signature)) {
      log.warn("webhook.mailgun.missing_signature_fields");
      return res.status(400).json({ ok: false, error: "Missing signature fields" });
    }

    let valid: boolean;
    try {
      valid = await verifyMailgunSignature(timestamp, token, signature);
    } catch {
      return res.status(503).json({ ok: false, error: "Webhook signing configuration is unavailable" });
    }
    if (!valid) {
      log.warn("webhook.mailgun.invalid_signature");
      return res.status(403).json({ ok: false, error: "Invalid signature" });
    }

    const from = body.from || body.sender;
    const to = body.recipient || body.To;
    const subject = body.subject || body.Subject;
    const bodyPlain = typeof body["body-plain"] === "string" ? body["body-plain"] : "";
    const strippedText = typeof body["stripped-text"] === "string" ? body["stripped-text"] : "";

    log.info("webhook.mailgun.incoming", {
      from,
      to,
      subject,
      bodyPlain: bodyPlain.substring(0, 500),
      strippedText: strippedText.substring(0, 500),
    });

    res.status(200).json({ ok: true });
  });

  return router;

}

export const webhooksRouter = createWebhooksRouter();
