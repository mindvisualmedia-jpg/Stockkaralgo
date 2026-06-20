# Deploy Stockkar Algo to Azure (one click)

This creates everything for you on Azure — network, firewall, public IP, and an
Ubuntu 24.04 VM — and then runs the installer automatically. You do **not** pick
a region, disk, or zone. You only choose an app name, a server size, and paste
your SSH key.

## Deploy

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fmindvisualmedia-jpg%2FStockkaralgo%2Fmain%2Fazure%2FmainTemplate.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fmindvisualmedia-jpg%2FStockkaralgo%2Fmain%2Fazure%2FcreateUiDefinition.json)

### What you fill in
1. **Resource group** — click *Create new*, any name (e.g. `stockkar-rg`).
2. **Your easy app name** — used in your URL, e.g. `rahul-algo`.
3. **SSH public key** — paste the contents of `id_ed25519.pub` / `id_rsa.pub`.
   - No key yet? On your PC run `ssh-keygen -t ed25519` then open
     `~/.ssh/id_ed25519.pub` and copy the one line.
4. **Server type** — leave on *Free tier - x64 (B2ats_v2)*.

Then **Review + create → Create**. The VM boots and the installer runs in the
background (~3–5 minutes).

## After deploy
Open the deployment's **Outputs** tab. You'll see:
- `appUrl` — e.g. `https://rahul-algo.<ip>.nip.io` (open this in your browser).
- `sshCommand` — to log into the box.
- `publicIP` — whitelist this IP in your broker if required.

If the page isn't up yet, give it a couple more minutes, or SSH in and check:

```bash
sudo tail -n 50 /var/log/stockkar-install.log
```

## First run
1. Set your App-Lock PIN.
2. Connect your broker (Dhan / Zerodha / Angel) in Settings.
3. Recommended: add 1 GB swap and an Azure cost alert (see DEPLOY_BACKEND.md).

## Free-tier notes
- **B2ats_v2** (x64) and **B2pts_v2** (Arm64) are free for 750 hrs/month for the
  first 12 months. Keep one VM running 24/7 and you stay within the free hours.
- The OS disk (StandardSSD) and public IP are small ongoing costs — set a budget
  alert so there are no surprises.
