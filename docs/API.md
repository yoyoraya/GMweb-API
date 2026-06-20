# GMweb API

Base URL:

```text
http://127.0.0.1:3030
```

Auth header, except public `/health` when `PUBLIC_HEALTH=true`:

```text
Authorization: Bearer <API_TOKEN>
```

## Endpoints

### GET /health

Returns service health.

### GET /ready

Starts/checks the browser session and returns `503` when Google Messages is not paired.

### POST /browser/start

Starts the controlled Chrome session and opens Google Messages.

### POST /browser/stop

Stops the browser session.

### POST /browser/restart

Stops and starts the browser session. Useful after a stuck Google Messages page.

### GET /session/status

Returns pairing/readiness state.

### GET /session/screenshot

Returns a PNG screenshot. Useful for first pairing on a headless VPS.

### GET /conversations?limit=20

Returns structured conversation rows:

```json
{
  "conversations": [
    {
      "id": "/web/conversations/...",
      "href": "/web/conversations/...",
      "title": "Contact name",
      "snippet": "Last message",
      "timestamp": "12:51 PM",
      "text": "Raw row text"
    }
  ]
}
```

### GET /messages/active?limit=50

Returns messages from the currently open conversation.

### POST /conversations/open

Opens a conversation by one of `id`, `href`, `title`, or `index`.

```json
{
  "title": "Contact name"
}
```

### POST /conversations/messages

Opens a conversation and returns messages from it.

```json
{
  "href": "/web/conversations/...",
  "limit": 50
}
```

### POST /send

```json
{
  "to": "+989195292411",
  "text": "test"
}
```

### GET /events

Server-sent events stream for sent-message and conversation-change events.
