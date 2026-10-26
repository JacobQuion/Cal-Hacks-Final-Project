# Rally

<a href="https://youtu.be/czPDelomrt4"><img src="https://img.youtube.com/vi/czPDelomrt4/maxresdefault.jpg" alt="Watch the Rally demo" width="100%"></a>

🥈 **2nd place out of 170 submissions** in the SpacetimeDB track at **Cal Hacks 13.0**.

## Functionality
- **Phone as controller:** scan a QR code and swing your phone like a racket or paddle with no app install
- **Badminton:** play 1v1 across two laptops with a live video call or take on an AI opponent
- **Bowling and ping pong:** solo modes that use the same phone pairing and motion controls
- **Strategy layer:** fog of war, hidden stamina and shot predictions keep each player's info private

## Tech Stack
- **SpacetimeDB:** acts as the game server, running every shot, point and AI decision server side
- **Three.js:** renders the 3D arenas, players and ball physics in the browser
- **Phone motion sensors:** read swing speed, angle and timing through the browser's DeviceMotion API
- **WebRTC:** streams peer to peer video between players, with SpacetimeDB relaying the connection setup
