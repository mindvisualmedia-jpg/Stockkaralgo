# Stockkar Oracle Always Free Setup

This Terraform package is for Oracle Cloud Infrastructure Resource Manager.

Recommended shape: VM.Standard.E2.1.Micro, Oracle Always Free eligible.

User steps:
1. Open Oracle Cloud Console.
2. Go to Developer Services > Resource Manager > Stacks.
3. Create stack from ZIP file and upload this package.
4. Enter tenancy OCID, compartment OCID, region, app name, and update PIN.
5. Keep the default shape unless Oracle says capacity is unavailable.
6. Create stack with Run apply enabled.
7. Open Outputs > AppUrl after apply succeeds.
8. Copy StaticIp into the broker static IP or whitelist settings.

This is separate from AWS. It does not modify AWS CloudFormation.
