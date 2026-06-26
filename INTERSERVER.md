# Stockkar on InterServer (VEE box)

InterServer is a plain KVM VPS host — no CloudFormation/ARM templates, no
documented snapshot/cloud-init/API. So we provision with the portable
[`bootstrap.sh`](bootstrap.sh): order an Ubuntu VPS, run one script, done.

Every InterServer VPS includes a **dedicated static IP** (needed for broker
whitelisting) and the cheapest slice — **$3/mo: 1 core, 2 GB RAM, 40 GB SSD** —
comfortably runs Stockkar.

---

## 1. Order the VPS
InterServer panel → **VPS** → deploy:
- OS: **Ubuntu 22.04**
- Size: **1 slice** (scale up later if needed)
- Region: closest to you
- Note the **IP** and **root password** it gives you.

## 2. SSH in
```bash
ssh root@<vps-ip>
```

## 3. Provision (one command)
The repo is **private**, so clone over HTTPS with a GitHub token. Create a
**fine-grained Personal Access Token** (GitHub → Settings → Developer settings →
Fine-grained tokens → read-only on `Stockkaralgo`), then:

```bash
curl -fsSLO https://raw.githubusercontent.com/mindvisualmedia-jpg/Stockkaralgo/main/bootstrap.sh 2>/dev/null || true
# (private repo: the line above won't fetch — paste bootstrap.sh manually, or:)
git clone https://<TOKEN>@github.com/mindvisualmedia-jpg/Stockkaralgo.git stockkar_electron
cd stockkar_electron && git checkout main
REPO_URL="https://<TOKEN>@github.com/mindvisualmedia-jpg/Stockkaralgo.git" BRANCH=main bash bootstrap.sh
```

`bootstrap.sh` installs Node 20 + pm2, checks out the branch, writes `.env`
(`HOST=0.0.0.0`, data dir, port), starts under pm2, and enables reboot
auto-start. It prints the URL at the end.

Env overrides (all optional):
| Var | Default | Notes |
|-----|---------|-------|
| `BRANCH` | `main` | `staging` for a test box |
| `DATA_DIR` | `$HOME/stockkar-data` | per-box isolated data |
| `PORT` | `7777` | app port |
| `INSECURE_COOKIE` | `1` | `0` if you put nginx + TLS in front |
| `PROTECT_AFTER_FILL` | `0` | `1` = place Forever/GTT only after entry fills |

## 4. Open the port
InterServer VPS has no blocking firewall by default, but if `ufw` is on:
```bash
ufw allow 7777/tcp && ufw allow OpenSSH && ufw --force enable
```

## 5. First run
- Browse to **`http://<vps-ip>:7777`**
- Set a **strong App-Lock PIN** (only gate on an HTTP box)
- Connect the broker token in Settings; **whitelist `<vps-ip>`** with the broker
- That dedicated IP is permanent → safe for broker whitelisting.

## Updating
```bash
cd ~/stockkar_electron && git pull && pm2 restart stockkar --update-env && pm2 save
```

## Going production (recommended hardening)
For a paid VEE, put **nginx + Let's Encrypt** in front (HTTPS), then set
`INSECURE_COOKIE=0` and proxy `:443 -> 127.0.0.1:7777`. The App-Lock PIN + HTTPS
is the right posture for a box that holds a broker token.
