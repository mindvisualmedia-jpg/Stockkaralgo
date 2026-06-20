# Stockkar Oracle Always Free Setup

This Terraform package is for Oracle Cloud Infrastructure Resource Manager.

Recommended shape: VM.Standard.E2.1.Micro, Oracle Always Free eligible.

User steps:
1. Open Oracle Cloud Console.
2. Go to Developer Services > Resource Manager > Stacks.
3. Create stack from ZIP file and upload this package.
4. Enter tenancy OCID, compartment OCID, region, app name, and your SSH public key.
5. Keep the default shape unless Oracle says capacity is unavailable.
6. Create stack with Run apply enabled.
7. Wait 5-8 minutes after apply succeeds (the install runs in the background on
   the small Always-Free instance), then open Outputs > AppUrl.
8. On first open: set your App Lock PIN, then connect your broker. Set your
   Update PIN in Settings > Software Updates.
9. Copy StaticIp into the broker static IP or whitelist settings.

Notes:
- The setup runs automatically via cloud-init and uses the same universal
  installer as every other host. Progress is logged to /var/log/stockkar-install.log.
- Oracle's Ubuntu image blocks all inbound ports except SSH at the OS firewall;
  this template opens and persists 22/80/443 in iptables for you.
- To troubleshoot, SSH in with the key you provided: `ssh ubuntu@<StaticIp>` then
  `sudo tail -n 50 /var/log/stockkar-install.log`.

This is separate from AWS. It does not modify AWS CloudFormation.
