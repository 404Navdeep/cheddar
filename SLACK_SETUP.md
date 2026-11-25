# Slack Notifications Setup

## 1. Environment variables

Add these to `.env.local` (and your Vercel project settings):

```env
# Slack Bot token (xoxb-…) — needed to DM users
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token-here

# Optional: Slack Incoming Webhook URL for channel posts (not used by DMs, kept for future use)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

## 2. Create the Slack app

1. Go to https://api.slack.com/apps and click **Create New App** → **From an app manifest**.
2. Pick your workspace, then paste the contents of [`slack-app-manifest.json`](/C:/Users/DELL/Downloads/Code/cheddar/slack-app-manifest.json).
3. Click **Create**.

## 3. Configure OAuth & Install

### Bot Token Scopes
Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:
- `chat:write` — send messages
- `im:write` — create DMs
- `im:read` — read DMs (needed to open DM channels)
- `users:read` — look up user info

### Install
Click **Install to Workspace** at the top of **OAuth & Permissions**. Copy the **Bot User OAuth Token** (starts with `xoxb-`) into `SLACK_BOT_TOKEN`.

## 4. Users need a Slack ID on file

Cheddar looks up each user's `slack_id` (from Hack Club Auth / their Cheddar profile) to DM them. Users without a Slack ID won't receive notifications.

## 5. What gets notified

| Event | Who | Channel |
|-------|-----|---------|
| Trade filled | Trader | DM |
| Order cancelled | Order owner | DM |
| Trade reversed | Both parties | DM |
| Proposal approved | Proposer | DM |
| Proposal rejected | Proposer | DM |
| Outcome suggestion approved | Suggester | DM |
| Outcome suggestion rejected | Suggester | DM |
| Settlement approved | Settlement proposer | DM (with payout amount) |
| Settlement rejected | Settlement proposer | DM |
| Latta granted | Recipient | DM |
| Account suspended | User | DM |
| Account unsuspended | User | DM |
| Made/demoted Cheesemonger | User | DM |
| Made/demoted super admin | User | DM |
| Outcome halted/resumed | Wheel traders | DM |

## 6. Site-wide announcements (Block Kit)

Go to **/admin** → **Slack** tab (super admins only). Paste a Slack Block Kit JSON `blocks` array and choose who to DM:

- **All users** — everyone with a Slack ID
- **Cheesemongers** — moderation team only
- **Super admins** — admins only

Example Block Kit JSON:
```json
[
  {
    "type": "header",
    "text": { "type": "plain_text", "text": "📢 Market maintenance" }
  },
  {
    "type": "section",
    "text": { "type": "mrkdwn", "text": "Trading will be paused for 10 minutes at 2pm EST for maintenance." }
  },
  {
    "type": "divider"
  },
  {
    "type": "context",
    "elements": [
      { "type": "mrkdwn", "text": "Sent by Cheddar admin • :cheese:" }
    ]
  }
]
```

All announcements are logged in the audit trail.

## 7. Vercel

Add `SLACK_BOT_TOKEN` to your Vercel project environment variables. The build command already runs migrations (`bun run db:migrate && bun run build`), so no build changes are needed.
