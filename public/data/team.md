# Team & mail routing

The agent maintains this file. **Edit the mail here** — the dashboard reads the
`json` block below and shows who is mailed for each gate. Everything outside the
block is just notes and renders as-is.

**Mail is sent _from_ Kalimuthu Kuppusamy** (`Kalimuthu.Kuppsamy@resdevtax.com`)
to the recipients below.

> **Security note:** this file is public (it ships to GitHub Pages), so it holds
> **only email addresses** — the routing. The Microsoft Graph tenant id, client
> id and **client secret** are **never** kept here; they live in the Mailer's
> environment / a secret store. The secret has been exposed in chat and must be
> **rotated in Entra** before any real send.

```json
{
  "from": "Kalimuthu.Kuppsamy@resdevtax.com",
  "people": [
    { "name": "Prithinga Senthilkumar", "email": "prithinga.senthilkumar@certainti.ai", "active": true },
    { "name": "Mahitha Nalu", "email": "mahitha.nalu@certainti.ai", "active": true },
    { "name": "Kalimuthu Kuppusamy", "email": "Kalimuthu.kuppusamy@certainti.ai", "active": true }
  ],
  "groups": [
    { "name": "Developers", "gate": "RG-Dev", "emails": ["prithinga.senthilkumar@certainti.ai"], "mode": "active-review" },
    { "name": "QA", "gate": "RG-Test", "emails": ["mahitha.nalu@certainti.ai"], "mode": "active-review" },
    { "name": "DevOps", "gate": "G4", "emails": ["Kalimuthu.kuppusamy@certainti.ai"], "mode": "active-review" }
  ]
}
```

## Roles

| Gate | Role | Recipient |
| --- | --- | --- |
| `RG-Dev` | Developer review | prithinga.senthilkumar@certainti.ai |
| `RG-Test` | QA | mahitha.nalu@certainti.ai |
| `G4` | DevOps / merge | Kalimuthu.kuppusamy@certainti.ai |

## Notes

- `RG-TL`, `RG-Ver` and `RG-Sec` have **no group yet** — the coverage strip
  flags them red, because an approval request for them would reach no one. Add a
  group with recipients when you want them routed.
- `mode` is informational in this read-only view: `active-review` means a person
  must reply `APPROVED`.
- The Graph **tenant id / client id / client secret** are configured in the
  Mailer's environment, not in this repo.
