# Zvault demo on one EC2 host

A cheap single-box demo: no domain, no RDS. For the real AWS setup see `infra/`.

| Piece      | How                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------ |
| TLS        | Host nginx + Let's Encrypt for `<ip-with-dashes>.sslip.io` (resolves to the IP, no domain) |
| API        | `zvault-api:demo` container on `127.0.0.1:3000`, served at `/v1/`                          |
| Database   | `postgres:17-alpine` container, not exposed outside Docker                                 |
| Email      | Amazon SES in `ap-south-1` over SMTP (STARTTLS, port 587); see below                       |
| Share page | Static build of `apps/share-web` at `/`                                                    |

## Email (SES)

The API sends through the SES SMTP endpoint with an IAM user that may only call `ses:SendRawEmail`.
`.env` on the box holds `SES_SMTP_USER`, `SES_SMTP_PASS` (the SMTP password derived from that user's
access key, not the key itself) and `MAIL_FROM`, which must be an SES-verified address. The stack
refuses to start while the SES values are empty.

The account is in the SES sandbox: it sends only to verified addresses, at most 200 a day. Verify a
tester with `aws sesv2 create-email-identity --email-identity them@example.com --region ap-south-1`
and have them click the link AWS emails them. Mail to anyone else is rejected. Leaving the sandbox
needs a production-access request, which AWS grants more readily with a domain you own.

## Deploy

Merging to `main` deploys automatically when the API, share page or these files change
(`.github/workflows/deploy-demo.yml`). It builds on GitHub, streams everything over SSH with a key
that `authorized_keys` locks to `deploy.sh`, then checks `/v1/health`. The key is the `DEMO_SSH_KEY`
secret in the `demo` environment, which only `main` can use. Run it by hand from the Actions tab.

The host line in `~/.ssh/authorized_keys` looks like
`restrict,command="HOST=52-66-189-120.sslip.io /home/ec2-user/zvault/deploy.sh" ssh-ed25519 ...`.
The `demo` environment also has variables `DEMO_HOST` and `DEMO_SSH_HOST_KEY` (`ssh-keyscan -t ed25519 $HOST`).

By hand, on the Mac (the box is x86_64; use `linux/arm64` for Graviton):

```sh
HOST=52-66-189-120.sslip.io
docker build --platform linux/amd64 -f infra/docker/api.Dockerfile -t zvault-api:demo .
(cd apps/share-web && VITE_API_URL=https://$HOST pnpm build)

scp deploy/ec2/{compose.yml,nginx-zvault.conf,setup.sh} demo-ec2:zvault/
tar -C apps/share-web/dist -cz . | ssh demo-ec2 'sudo mkdir -p /usr/share/nginx/zvault-share && sudo tar -xz -C /usr/share/nginx/zvault-share'
docker save zvault-api:demo | gzip | ssh demo-ec2 'gunzip | docker load'
ssh demo-ec2 "cd zvault && HOST=$HOST ./setup.sh"   # first time; later: docker compose up -d
```

`setup.sh` adds 1 GB swap, writes `.env` with random secrets, issues the cert, installs the nginx
site and a daily renewal timer, then starts the stack. Migrations run on every `up` (the `migrate`
service) before the API starts.

Check: `curl https://$HOST/v1/health`.

## Desktop app

Build it against the server (the CSP override lets the app call it):

```sh
cd apps/desktop
VITE_API_URL=https://$HOST VITE_SHARE_ORIGIN=https://$HOST pnpm tauri build --config \
  "{\"app\":{\"security\":{\"csp\":\"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost https://$HOST; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'\"}}}"
```

## Known demo limits

- Share links are held in memory by the API today, so they disappear when the API restarts.
- Only SES-verified addresses receive email (sandbox).
- One box, no backups. Snapshot the EBS volume if the data matters.
