# Telegram Clone Project

## Project Structure

```
├── docker-compose.yml          # Docker Compose configuration
├── Dockerfile                  # Docker image build file
├── package.json                # NPM dependencies and scripts
├── package-lock.json           # NPM lock file
├── public/                     # Static assets served by the server
│   ├── app.js
│   ├── encryption-client.js
│   ├── index.html
│   ├── public-chat.html
│   ├── public-chat.js
│   ├── public-profile.html
│   ├── public-profile.js
│   └── styles.css
├── scripts/                    # Helper scripts (backup, etc.)
│   ├── backup.ps1
│   └── backup.sh
├── src/                        # Application source code
│   ├── auth.js
│   ├── chatService.js
│   ├── config.js
│   ├── db.js
│   ├── encryption.js
│   ├── init.sql
│   ├── moderationService.js
│   ├── server.js
│   ├── sms.js
│   ├── socket.js
│   ├── storage.js
│   ├── telegramBot.js
│   ├── utils.js
│   └── routes/                # Express route handlers
├── uploads/                    # Uploaded media (avatars, etc.)
└── .git/                       # Git metadata
```

## Getting Started

```bash
npm install
npm start
```

The application will be available at `http://localhost:3000`.
```