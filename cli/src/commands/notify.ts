import { isBarryError } from "@barry-rocks/sdk";
import { CliError, isCliError } from "../lib/cli-error.js";
import { identityRecords, type IdentityRecord } from "@barry-rocks/identities-bag";
import { Events } from "@barry-rocks/events-bag";
import { identityEnvironment } from "@barry-rocks/sdk/internal/env";
import { getCurrentUser, getActiveIdentity } from "../lib/current-user.js";

const SLACK_API_URL = "https://slack.com/api/chat.postMessage";
const SELFPING_API_URL = "https://www.selfping.com/api/sms";
const SLACK_DM_CHANNEL = "D0A9NEJ66C8"; // Barry bot -> Tyler Perin

type Channel = "slack" | "sms";

interface NotifyOptions {
  channel?: string;
  /** The identity to use. Registered as `--name`; see the note at its read. */
  name?: string;
  type?: string;
  severity?: string;
}

/**
 * Resolve the channel from --channel flag or barry's status_notify config.
 * Maps MCP tool names (send_slack_message, send_sms) to channel names.
 */
function resolveChannel(
  explicitChannel: string | undefined,
  statusNotify: { tool?: string } | undefined,
): Channel | null {
  if (explicitChannel) {
    if (explicitChannel === "slack" || explicitChannel === "sms") return explicitChannel;
    throw new CliError(`Unknown channel "${explicitChannel}". Valid: slack, sms`, 1);
  }

  if (!statusNotify?.tool) return null;

  if (statusNotify.tool.includes("slack")) return "slack";
  if (statusNotify.tool.includes("sms")) return "sms";

  return null;
}

async function sendSlack(message: string, token: string, target?: string): Promise<void> {
  const channel = target || SLACK_DM_CHANNEL;

  const response = await fetch(SLACK_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text: message,
      unfurl_links: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Slack API rejected: ${result.error}`);
  }
}

async function sendSms(message: string, apiKey: string): Promise<void> {
  const response = await fetch(SELFPING_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new Error(`SelfPing API error: ${response.status} ${await response.text()}`);
  }
}

async function resolveCredentials(identity: IdentityRecord): Promise<Record<string, string>> {
  const resolvedConfig = identityRecords.config(identity);
  try {
    const env = await identityEnvironment(resolvedConfig);
    return env.vars;
  } catch {
    // Vault unavailable or a definition that will not read — continue with keychain/env only
    return {};
  }
}

export async function notifyCommand(
  message: string,
  options: NotifyOptions,
): Promise<void> {
  try {
    if (!message || message.trim().length === 0) {
      throw new CliError("Usage: barry notify <message> [--channel slack|sms] [--name <name>]", 1);
    }

    const user = await getCurrentUser();
    // `options.name`, not `options.barry`: the flag registered in index.ts is
    // `--name`, so Commander only ever sets `name`. Reading `barry` meant the
    // flag parsed and was then discarded, silently falling back to the active
    // identity — the wrong answer looked exactly like the right one.
    const identityName = options.name || getActiveIdentity(user);

    if (!identityName) {
      console.log(`[notify] ${message}`);
      console.error("No barry configured. Set one with: barry set <name>");
      return;
    }

    let identity: IdentityRecord;
    try {
      identity = (await identityRecords.find(identityName)).record;
    } catch (error) {
      if (isCliError(error)) throw error;
      if (!isBarryError(error)) throw error;
      throw new CliError(error.reason === "not_found" ? `Barry "${identityName}" not found` : `Error: ${error.message}`, 1);
    }

    const resolvedConfig = identityRecords.config(identity);
    const statusNotify = resolvedConfig.status_notify as { tool?: string; target?: string } | undefined;

    const channel = resolveChannel(options.channel, statusNotify);

    if (!channel) {
      // No channel configured — print to stdout so job logs capture it
      console.log(`[notify] ${message}`);
      console.error("No notification channel configured. Use --channel or set a barry notifier.");
      return;
    }

    const creds = await resolveCredentials(identity);

    if (channel === "slack") {
      const token = creds.SLACK_BOT_TOKEN;
      if (!token) {
        console.log(`[notify] ${message}`);
        throw new CliError("SLACK_BOT_TOKEN not available on this barry. Cannot send Slack message.", 1);
      }
      const target = statusNotify?.target || SLACK_DM_CHANNEL;
      await sendSlack(message, token, target);
      console.log(`Sent via Slack → ${target}`);
    } else if (channel === "sms") {
      const apiKey = creds.SELFPING_API_KEY;
      if (!apiKey) {
        console.log(`[notify] ${message}`);
        throw new CliError("SELFPING_API_KEY not available on this barry. Cannot send SMS.", 1);
      }
      await sendSms(message, apiKey);
      console.log("Sent via SMS");
    }

    // Record as an event (non-fatal if it fails)
    try {
      await Events.create({
        type: options.type ?? "notification",
        source: "cli",
        title: message,
        severity: options.severity ?? "info",
        data: { channel, barry: identityName },
      });
    } catch {
      // Event recording is best-effort — delivery already succeeded
    }
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Notify failed: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}
