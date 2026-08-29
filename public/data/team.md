# Team & mail routing

The agent maintains this file. **Edit the mail here** — the dashboard reads the
`json` block below and shows who is mailed for each gate. Everything outside the
block is just notes and renders as-is.

To change who gets an approval mail for a gate, edit that group's `emails`, then
commit and redeploy. No backend, no forms — the file is the source of truth.

```json
{
  "people": [
    { "name": "Dev Reviewer One", "email": "dev-one@example.com", "active": true },
    { "name": "Dev Reviewer Two", "email": "dev-two@example.com", "active": true },
    { "name": "QA Lead", "email": "qa-one@example.com", "active": true },
    { "name": "DevOps Approver", "email": "devops-one@example.com", "active": true },
    { "name": "Security Reviewer", "email": "sec-one@example.com", "active": true }
  ],
  "groups": [
    { "name": "Developers", "gate": "RG-Dev", "emails": ["dev-one@example.com", "dev-two@example.com"], "mode": "active-review" },
    { "name": "QA", "gate": "RG-Test", "emails": ["qa-one@example.com"], "mode": "active-review" },
    { "name": "DevOps", "gate": "G4", "emails": ["devops-one@example.com"], "mode": "standing-delegation" },
    { "name": "Security", "gate": "RG-Sec", "emails": ["sec-one@example.com"], "mode": "active-review" }
  ]
}
```

## Notes

- `RG-TL` and `RG-Ver` have **no group yet** — the coverage strip above flags
  them red, because an approval request for them would reach no one.
- Emails here are placeholders (`@example.com`). Replace them with the real
  reviewer addresses.
- `mode` is informational in this read-only view: `active-review` means a person
  must reply `APPROVED`; `standing-delegation` is a pre-agreed standing approval.
