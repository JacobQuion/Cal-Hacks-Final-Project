# Rally 🏸

<a href="https://youtu.be/czPDelomrt4"><img src="https://img.youtube.com/vi/czPDelomrt4/maxresdefault.jpg" alt="Watch the Rally demo" width="100%"></a>

<p align="center"><i>Click the video above to watch the full demo on YouTube</i></p>

**Turn your phone into a motion controller for 3D sports games on your laptop.**

2nd place out of 200 submissions in the SpacetimeDB track at Cal Hacks 13.0

---

## About

- Scan a QR code and swing your phone like a racket or paddle with no app install
- Play badminton 1v1 across two laptops with a live video call or against an AI opponent
- Bowling and ping pong solo modes use the same phone pairing
- Fog of war and hidden stamina keep each player's info private

---

## Tech Stack

- **Game server:** SpacetimeDB runs every shot and AI decision server side
- **3D graphics:** Three.js renders the arenas and ball physics in the browser
- **Motion input:** phone sensors read swing speed and timing through the DeviceMotion API
- **Video:** WebRTC streams peer to peer video with SpacetimeDB relaying the setup
