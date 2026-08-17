# Docker Setup for Cheszio

This document explains how to run the chess application using Docker for both development and production.

## Architecture

- **Backend**: Node.js + Express + Socket.IO (port 3000)
- **Frontend**: React + Vite (served via Nginx on port 80 in production)
- **Docker Compose**: Orchestrates both services with proper networking

## Local Development

For the fastest development experience, **only the backend runs in Docker** with live reload. The frontend runs natively using Vite's dev server for instant HMR.

### Start Development Environment

```bash
# Terminal 1: Start backend in Docker (with live reload)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Terminal 2: Run frontend natively (fastest HMR)
cd client
npm install  # First time only
npm run dev
```

The backend will automatically reload when you change server code (thanks to nodemon). The frontend will have instant hot module replacement.

### Stop Development Environment

```bash
# Stop backend container
docker compose -f docker-compose.yml -f docker-compose.dev.yml down

# Stop frontend (Ctrl+C in the terminal running npm run dev)
```

## Production Build & Run

### Build Images

```bash
docker compose build
```

This creates optimized production images:
- Backend: Node.js running `node index.js`
- Frontend: Multi-stage build → Vite production build → Nginx serving static files

### Run Production Stack

```bash
docker compose up -d
```

Access the app:
- Frontend: http://localhost
- Backend API: http://localhost:3000

### Stop Production Stack

```bash
docker compose down
```

## VPS Deployment (Production)

### Prerequisites

1. A VPS with Docker and Docker Compose installed
2. Domain name pointing to your VPS IP
3. Ports 80 and 443 open in firewall

### Deployment Steps

1. **Clone repository on VPS**
   ```bash
   git clone <your-repo-url>
   cd cheszio
   ```

2. **Configure environment variables**
   
   Edit `docker-compose.yml` and set `ALLOWED_ORIGINS` to your domain:
   ```yaml
   environment:
     - PORT=3000
     - ALLOWED_ORIGINS=https://yourdomain.com
   ```

3. **Build and start**
   ```bash
   docker compose up -d --build
   ```

4. **Set up HTTPS**

   **Option A: Using Caddy (recommended)**
   
   Create `Caddyfile`:
   ```
   yourdomain.com {
       reverse_proxy localhost:80
   }
   ```
   
   Run Caddy:
   ```bash
   sudo caddy run
   ```
   
   **Option B: Using Certbot + Nginx**
   
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d yourdomain.com
   ```

5. **Verify deployment**
   ```bash
   curl https://yourdomain.com
   docker compose logs
   ```

## Environment Variables

### Backend (`server/`)

- `PORT` (default: 3000) - Server port
- `ALLOWED_ORIGINS` - Comma-separated list of allowed CORS origins
  - Development: Leave unset (allows all origins)
  - Production: Set to your domain (e.g., `https://yourdomain.com`)

### Frontend (`client/`)

- `VITE_API_URL` - Backend URL for Socket.IO connection
  - Development (native): Leave unset (uses empty string = same-origin)
  - Production: Leave unset (Nginx proxies to backend)

## Key Differences: Development vs Production

| Aspect | Development | Production |
|--------|-------------|------------|
| Frontend | Native `npm run dev` (port 5173) | Nginx serving static build (port 80) |
| Backend | Docker with volume mounts + nodemon | Docker running `node index.js` |
| Hot Reload | ✅ Instant (Vite HMR + nodemon) | ❌ Requires rebuild |
| CORS | Open (all origins) | Restricted to ALLOWED_ORIGINS |
| Build Time | N/A (no build needed) | ~20-30s for both images |

## Troubleshooting

### Development Issues

**Frontend can't connect to backend**
```bash
# Check backend is running
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps

# Check backend logs
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs backend

# Verify backend responds
curl http://localhost:3000/api/check-room/test
```

**Backend not auto-reloading**
- Ensure volume mounts are correct in docker-compose.dev.yml
- Check nodemon is watching the right files

**Port conflicts**
- Backend uses 3000, frontend dev uses 5173
- Stop any processes using these ports

### Production Issues

**Frontend shows blank page**
```bash
# Check Nginx logs
docker compose logs frontend

# Verify build completed
docker compose exec frontend ls /usr/share/nginx/html
```

**CORS errors in browser**
- Set ALLOWED_ORIGINS in docker-compose.yml to your domain
- Restart: `docker compose down && docker compose up -d`

**WebSocket connection fails**
- Check Nginx config has WebSocket upgrade headers
- Verify `/socket.io` proxy is working

## Quick Reference

```bash
# Development
docker compose -f docker-compose.yml -f docker-compose.dev.yml up  # Backend only
cd client && npm run dev  # Frontend (separate terminal)

# Production - Local
docker compose up -d --build

# Production - VPS
git pull && docker compose up -d --build

# View logs
docker compose logs -f [service-name]

# Rebuild single service
docker compose build [service-name]

# Clean up
docker compose down -v  # Remove containers and volumes
```

## Architecture Details

### Nginx Configuration

The production frontend uses Nginx with:
- **Reverse proxy** for `/api` and `/socket.io` to backend
- **SPA routing** with `try_files` fallback to `index.html`
- **WebSocket support** via upgrade headers
- **Gzip compression** for better performance
- **Asset caching** (365 days for static files)

### Docker Networking

- Both services run on the same Docker network
- Backend is accessible as `backend:3000` within the network
- Nginx proxies requests to `http://backend:3000`
- Only ports 80 and 3000 are exposed to host

### Multi-stage Build (Frontend)

1. **Builder stage**: Runs `npm ci && npm run build` in node:20-alpine
2. **Serve stage**: Copies built files to nginx:alpine
3. Final image size: ~50MB (vs ~500MB if keeping Node.js)
