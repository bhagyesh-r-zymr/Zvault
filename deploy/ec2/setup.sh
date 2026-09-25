#!/usr/bin/env bash
# One-time setup on the EC2 host (Amazon Linux 2023, nginx + Docker already installed).
# Run from ~/zvault after copying deploy/ec2/* there:  HOST=52-66-189-120.sslip.io ./setup.sh
set -euo pipefail
: "${HOST:?set HOST, e.g. 52-66-189-120.sslip.io}"
cd "$(dirname "$0")"

# 1 GB swap: a t3.micro has under 1 GB of RAM.
if ! swapon --show | grep -q /swapfile; then
  sudo dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap defaults 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# Secrets, generated once.
if [ ! -f .env ]; then
  (umask 077; cat > .env) <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SERVER_SECRET=$(openssl rand -base64 48 | tr -d '\n')
TWO_FACTOR_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
MAIL_UI_AUTH=demo:$(openssl rand -hex 8)
CORS_ORIGINS=https://$HOST,tauri://localhost,http://tauri.localhost
MAIL_FROM=Zvault <no-reply@$HOST>
EOF
fi

# Self-signed cert so the API can talk STARTTLS to Mailpit.
if [ ! -f certs/mailpit.crt ]; then
  mkdir -p certs
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=mailpit \
    -addext subjectAltName=DNS:mailpit -keyout certs/mailpit.key -out certs/mailpit.crt 2>/dev/null
  chmod 644 certs/mailpit.key # read by the Mailpit container user
fi

# Let's Encrypt cert for $HOST via the webroot on port 80.
sudo mkdir -p /var/www/acme /etc/letsencrypt
if [ ! -d "/etc/letsencrypt/live/$HOST" ]; then
  # Serve only the HTTP challenge until the cert exists.
  sed "s/HOST/$HOST/g" nginx-zvault.conf | awk '1; /^}/{exit}' | sudo tee /etc/nginx/conf.d/zvault.conf >/dev/null
  sudo nginx -t && sudo systemctl reload nginx
  sudo docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /var/www/acme:/var/www/acme \
    certbot/certbot certonly --webroot -w /var/www/acme -d "$HOST" \
    --agree-tos --register-unsafely-without-email --non-interactive
fi
sed "s/HOST/$HOST/g" nginx-zvault.conf | sudo tee /etc/nginx/conf.d/zvault.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx

# Renew daily (Amazon Linux 2023 has no cron); certbot only acts near expiry.
sudo tee /etc/systemd/system/zvault-certbot.service >/dev/null <<'EOF'
[Service]
Type=oneshot
ExecStart=/usr/bin/docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /var/www/acme:/var/www/acme certbot/certbot renew -q
ExecStartPost=/usr/bin/systemctl reload nginx
EOF
sudo tee /etc/systemd/system/zvault-certbot.timer >/dev/null <<'EOF'
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now zvault-certbot.timer

docker compose up -d
