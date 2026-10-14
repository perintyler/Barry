# Security

Report suspected vulnerabilities privately to [platypus@barry.rocks](mailto:platypus@barry.rocks), the project contact listed in the support playbook. Include the affected version or source commit, platform, reproduction steps, expected and actual behavior, and redacted logs. Do not post credentials, installation secrets or an exploitable report in a public issue.

## Trust model

Barry defaults to loopback services authenticated by an installation shared secret; possession of that secret grants installation-level access. Remote deployments require explicit transport authentication and a separately reviewed deployment boundary.

Tool guards provide best-effort protection against mistakes, not a security boundary against a hostile agent or arbitrary shell execution. Requested sandbox enforcement must fail when the route cannot enforce it; required inherited bounds must remain in force. The guard threat model is recorded with the review program's decisions, which are kept outside the repository.

The SDK is linked-only while its distribution contract is being settled. Report the exact installed build when testing a suspected issue.
