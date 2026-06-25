# Deployment & Staging Guide

This app is **single-tenant**: every user runs their own isolated AWS box with
their own broker tokens, and updates by pulling from GitHub.

- **Production** boxes track the **`main`** branch.
- **Staging** is a separate AWS box that tracks the **`staging`** branch.
- Nothing on `staging` reaches any user until `staging` is merged into `main`.

Repo: `https://github.com/mindvisualmedia-jpg/Stockkaralgo`

---

## One-click deploy (Azure)

Click to deploy the staging VM straight into your Azure subscription. It builds
the VM + public IP + network security group (ports open to **your IP only**) and
auto-bootstraps Node/pm2 + the app on the `staging` branch.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fmindvisualmedia-jpg%2FStockkaralgo%2Fstaging%2Fazuredeploy.json)

You'll be asked for just three things:
- **sshPublicKey** — paste the contents of your `id_rsa.pub`
- **myIpCidr** — your public IP as CIDR, e.g. `203.0.113.4/32` (from whatismyip.com)
- **Resource group** — pick `stockkar-algo_group` or create a new one

When it finishes, the deployment **Outputs** tab gives you `stagingURL`
(`http://<ip>:7777`), `publicIp`, and `sshCommand`. Open the URL, set a strong
App-Lock PIN, connect your Dhan token, and you're testing.

> First boot runs the bootstrap (~2-3 min). If the page isn't up immediately,
> wait a moment and refresh.

### CLI alternative
```bash
az deployment group create \
  --resource-group stockkar-algo_group \
  --template-file azuredeploy.json \
  --parameters sshPublicKey="$(cat ~/.ssh/id_rsa.pub)" myIpCidr="YOUR.IP/32"
```

The same `staging` -> `main` promote flow below applies regardless of cloud.

---

## Branch model

```
new work ──▶ staging branch ──▶ staging EC2 (you test) ──▶ merge to main ──▶ user/prod boxes pull main
```

Production is untouched until the merge. That is the whole guarantee.

---

## One-time: stand up the staging EC2

### 1. Launch the instance
- EC2 → **Launch instance**
- **Name:** `stockkar-staging`
- **AMI:** Ubuntu Server 22.04 LTS
- **Type:** `t3.small` (or `t3.micro` for free tier)
- **Key pair:** create/download `stockkar-staging-key.pem` (needed for SSH)
- **Security group (new):**
  - SSH (22) → Source **My IP**
  - Custom TCP **7777** → Source **My IP**
  - ⚠️ Never `0.0.0.0/0`. "My IP" is what keeps staging private to you.
- **Storage:** 20 GB → **Launch**

### 2. Allow SSM (for App-Lock PIN reset)
- Instance → **Actions → Security → Modify IAM role**
- Attach a role with **`AmazonSSMManagedInstanceCore`**

### 3. SSH in (Windows PowerShell)
```powershell
ssh -i .\stockkar-staging-key.pem ubuntu@<staging-ec2-public-ip>
```

### 4. Install Node + pm2 + git
```bash
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
sudo npm install -g pm2
```

### 5. Clone on the staging branch
```bash
cd /home/ubuntu
git clone https://github.com/mindvisualmedia-jpg/Stockkaralgo.git stockkar_electron
cd stockkar_electron
git checkout staging
git branch            # confirm: * staging
```

### 6. Run with isolated data
```bash
export STOCKKAR_DATA_DIR=/home/ubuntu/stockkar-staging-data
export STOCKKAR_FYERS_LIVE=1        # only if testing FYERS
pm2 start server.js --name stockkar-staging --update-env
pm2 save
pm2 startup           # run the command it prints, for auto-start on reboot
pm2 logs stockkar-staging --lines 30
```

### 7. Open & lock it
- Browser → `http://<staging-ec2-public-ip>:7777`
- Set a **strong App-Lock PIN**
- Connect your **Dhan token** → real orders. Use **tiny qty**; clean up test
  positions in Dhan after each session.

**URL:** `http://<staging-ec2-public-ip>:7777`
**Who can see it:** only you — port 7777 is open to your IP only, App-Lock gates
it, and the app is `noindex`. Users never see it; they run their own boxes.

---

## Each test cycle: pull new fixes onto staging

```bash
cd /home/ubuntu/stockkar_electron
git pull                              # pulls staging (branch is checked out)
pm2 restart stockkar-staging --update-env
pm2 logs stockkar-staging --lines 30
```

---

## Promote staging → production (when staging is verified)

From a dev machine:
```bash
git checkout main
git pull
git merge staging
# bump version in package.json, then:
git commit -am "release: <summary>"
git push origin main
```
User/prod boxes then pick it up via their normal one-click update (pull `main`).

---

## Env flags (per-box)

| Flag | Default | Purpose |
|------|---------|---------|
| `STOCKKAR_DATA_DIR` | `/home/ubuntu/stockkar-data` | Data directory (use a separate one on staging) |
| `STOCKKAR_SPLIT_T1` | on (`0` disables) | Split-T1 two-OCO bracket |
| `STOCKKAR_DHAN_FOREVER` | on | Dhan Forever protective orders |
| `STOCKKAR_FYERS_LIVE` | off (`1` enables) | FYERS live placement + MTM live exit |
| `STOCKKAR_DHAN_ORDER_GAP_MS` | `400` | Throttle between Dhan order calls |
| `STOCKKAR_DEFAULT_MAX_OPEN` | `5` | Fallback max open positions |
| `STOCKKAR_SL_LIMIT_BUFFER_PCT` | `0.5` | SL limit buffer |
| `STOCKKAR_SL_AUTORESTORE` | on | Auto-restore missing stops |
| `STOCKKAR_PROTECT_AFTER_FILL` | off (`1` enables) | Place Forever/GTT only after the entry FILLS (no naked/orphan on pending or rejected LIMIT entries). Dhan + Zerodha. |
| `STOCKKAR_INSECURE_COOKIE` | off (`1` enables) | Omit the Secure cookie flag — required for an HTTP-only staging box, never on HTTPS prod |
| `STOCKKAR_PIN_RESET_DELAY_MINUTES` | — | App-Lock PIN reset delay |

---

## App-Lock PIN reset (staging or prod)

Requires **box access** (SSH or SSM) — there is no public no-verification reset.
