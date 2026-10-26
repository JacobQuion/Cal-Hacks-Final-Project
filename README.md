# Rally

[![Watch the Rally demo](https://img.youtube.com/vi/czPDelomrt4/hqdefault.jpg)](https://youtu.be/czPDelomrt4)

🥈 **2nd place out of 170 submissions** in the SpacetimeDB track at **Cal Hacks 13.0**.

Rally turns your phone into a motion controller for 3D sports games on your laptop. Scan a QR code and swing your phone like a racket or paddle with no app install.

## Games
- **Badminton:** 1v1 across two laptops or against an AI opponent
- **Bowling and ping pong:** solo modes using the same phone pairing

## Highlights
- **The database is the game server:** every shot and AI decision runs inside SpacetimeDB
- **Cheat resistant:** the server computes each shot and checks swing timing against its own clock
- **Fog of war:** your opponent's shot never reaches your laptop until it crosses the net
- **Hidden info:** stamina and shot predictions live in private tables only their owner can read
- **Shared physics:** one file runs on client and server so the referee and animation never disagree

Built with **SpacetimeDB** and **Three.js**.

## Run it locally
Start a local server with `spacetime start`, then run:

```bash
npm install
cd spacetimedb && npm install && cd ..
npm run db:publish
npm run dev
```

Open http://localhost:5180 and use a `cloudflared` tunnel so phones get the HTTPS they need for motion sensors.
