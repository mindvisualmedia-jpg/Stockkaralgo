#cloud-config
package_update: false
package_upgrade: false

write_files:
  - path: /usr/local/sbin/stockkar-oracle-install.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -euo pipefail
      exec >>/var/log/stockkar-install.log 2>&1
      echo "=== Stockkar Oracle install started: $(date) ==="

      export DEBIAN_FRONTEND=noninteractive
      APP_NAME="${app_name}"
      GIT_REPO="${git_repo}"

      # Wait for outbound internet (reserved public IP + IGW can take a moment).
      for i in $(seq 1 120); do
        curl -fsS --connect-timeout 5 https://api.ipify.org >/dev/null 2>&1 && break
        sleep 10
      done

      # Oracle's Ubuntu image ships iptables rules that REJECT all inbound
      # except SSH. Open 22/80/443 BEFORE the REJECT rule and persist them so
      # they survive reboots. This is the #1 reason Oracle web apps time out.
      iptables -I INPUT -p tcp --dport 22 -j ACCEPT || true
      iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true
      iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true
      apt-get update -y || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent netfilter-persistent || true
      netfilter-persistent save || true

      # Hand off to the universal installer (same one used on Azure/any VPS).
      # ubuntu is the default Oracle Ubuntu user; skip ufw so it doesn't fight
      # the iptables rules we just persisted.
      curl -fsSL "https://raw.githubusercontent.com/mindvisualmedia-jpg/Stockkaralgo/main/scripts/install.sh" -o /root/install.sh
      STOCKKAR_USER=ubuntu \
        STOCKKAR_APP_NAME="$APP_NAME" \
        STOCKKAR_REPO="$GIT_REPO" \
        STOCKKAR_SKIP_UFW=1 \
        bash /root/install.sh
      echo "=== Stockkar Oracle install finished: $(date) ==="

runcmd:
  - [ bash, /usr/local/sbin/stockkar-oracle-install.sh ]
