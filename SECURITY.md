# Security Policy

## Supported Versions

Because this repository is under active early development, security fixes are currently applied to the `main` branch only.

| Version | Supported |
|---------|-----------|
| `main` | Yes |

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public GitHub issues.

Instead, use one of these private reporting paths:

1. GitHub's **Private vulnerability reporting** feature for this repository, if enabled.
2. Direct maintainer contact through the private channel published in the repository settings/profile.

When reporting a vulnerability, please include:

- A clear description of the issue
- Steps to reproduce or a minimal proof of concept
- The affected files, commands, or generated artifacts
- Impact assessment (what an attacker could do)
- Any suggested mitigation, if you have one

You can expect:

- An initial acknowledgement within 7 days
- A follow-up once the issue has been triaged
- Coordination on disclosure timing for validated reports

## Scope

Security reports are especially helpful for:

- Secret leakage in generated artifacts or helper scripts
- Unsafe defaults in generated Azure infrastructure or workflows
- Privilege escalation paths in generated RBAC or managed identity bindings
- Injection risks in generated mappings, contracts, or workflow expressions
- Supply-chain risks in scripts, CI workflows, or dependencies

## Disclosure Policy

Once a report is validated, maintainers will work on a fix and coordinate disclosure. Please avoid public disclosure until a fix or mitigation is available.

## Hardening Guidance

For users of this project:

- Review generated artifacts before deployment
- Never commit secrets into generated integration folders
- Prefer managed identity and Key Vault references over inline credentials
- Enable repository-level secret scanning and dependency alerts
- Run the relevant validation and review stages before deployment
