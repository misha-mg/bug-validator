# Commands and buttons in Slack

Status: idea, not decided. Raised by the owner on 2026-11-05, the day the Slack messages went
in (PRD, Decisions), and parked the same day.

## Question it would answer

Can a person act on a message without opening the console? The message quotes the comment
proposed; posting it, or asking for a check of another bug, still means the console or the
command line.

## The idea

Slack as a second console for the two writes the service already serves: a check asked for
(`requests`) and a post (`posts`). Nothing new in the pipeline, only a transport:

- **Socket Mode**, not a request URL: the service opens a WebSocket to Slack from inside the
  network, so no public address, tunnel or signature check is needed. Node 24 has WebSocket
  built in, so no Bolt SDK and the dependency rule (zod only) holds. An app-level token
  (`xapp-…`, scope `connections:write`), the bot scope `commands`, the bot invited to the
  channel.
- **Buttons under the message** ("Post to Jira", "Check again") rather than a post command: the
  button sits under the comment the person has just read, which keeps the PRD's rule that a
  person confirms a comment with its text in front of them. A `/bv post KEY` typed blind would
  have to answer with the text and ask again.
- **One command** `/bv check KEY` for a bug no message was sent about; `/check` and `/bug` are
  names another app in the workspace may hold.
- Only listed Slack users (`VALIDATOR_SLACK_USERS`) may post or ask: a post is a write to Jira,
  and the channel is open to the workspace.
- About the size of the messages themselves: a `server/slack/socket.ts` next to the agent's
  Jira tool, a handler that writes the row and answers "taken, the result is in the console",
  tests with a fake socket, two log events, a decision in the PRD.

## Open

- Whether buttons alone are enough, or a command is wanted at all.
- Where the listener lives: the service (it owns the write path and runs the Jira tool's
  server already) or the console process.
- Updating the message after a click ("posted") needs `chat:write` or the click's
  `response_url`; which, and whether the message then also says when the check ended.
