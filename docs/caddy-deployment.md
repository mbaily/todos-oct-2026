# Deploy behind Caddy

This example serves the app at `https://todos.example.com/todos/`. Use your own
hostname and configure authentication for this route before opening it to the
internet. The app shares one database across all connected clients.

Build and start the app from its checkout:

```sh
npm ci
BASE_PATH=/todos/ npm run build
HOST=127.0.0.1 PORT=3000 DB_PATH=./data/todos.sqlite node server.js
```

Merge the routes in [Caddyfile.example](../deploy/Caddyfile.example) into the
HTTPS site for your hostname. The proxy strips `/todos` before forwarding
requests to the loopback backend. If you change the prefix, update both the
routes and `BASE_PATH`, including its trailing slash.

Caddy can prompt for a username and password over HTTPS. Apply authentication
to the entire app route so it covers both HTTP sync and WebSocket connections.
A browser that has already synced can still display its local copy offline.
Use a trusted browser profile for that data.
[Caddy authentication docs](https://caddyserver.com/docs/caddyfile/directives/basic_auth)

After reloading Caddy, check that the page loads and edits sync. Keep the same
origin across redeployments so browsers can continue to use their saved local
data and pending edits. Use SQLite's online backup API for a running service,
or stop the service before copying the database and any WAL/SHM files.
