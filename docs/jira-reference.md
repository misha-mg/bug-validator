# Jira reference

Ids and facts the service depends on, read from Jira on 2026-10-14…16. Field ids change only
when an admin changes them; re-check against Jira when something does not match.

## Site and credentials

- https://cgstowernetworks.atlassian.net, cloud id `0ba987c4-6759-4967-afaa-f80e0e69c8fc`.
- REST: basic auth with `JIRA_EMAIL` and a **scoped API token** from id.atlassian.com (Security →
  API tokens → create with scopes; read Jira work, write Jira work for comments). A scoped token
  works only through `https://api.atlassian.com/ex/jira/<cloud id>/rest/api/2`, which is what
  `src/jira/client.ts` uses. A Rovo token does not work with REST.
- The service runs from a personal account; no bot account for now.

## Projects and products

| Key | Name | Product |
|---|---|---|
| KAZ | Kazaar | NPB hardware: boxes with several board types (below) |
| RPG | Arpeggio | AFS, a virtual appliance on a general-purpose server; board type ANPB. An RPG bug is AFS by definition |
| DM | — | TPM; out of scope |

| Board type | Product | Chip |
|---|---|---|
| ANPB | Arpeggio (AFS) | virtual |
| NPB-II | Kazaar | Tomahawk 1 |
| NPB-IIe | Ristretto | Trident 3 |
| NPB-III | Napoli | Tomahawk 3 |
| NPB-IV | Cuba | Jericho 2 |
| NPB-Ie | India | Jericho 1 (Qumran) |
| NPB-Ie6, NPB-Ie6-XL, NPB-Ie8 | Volluto | Trident 3 |
| NPB-IOT | Volluto | — |

Retired: NPB-I (Dharkan, Trident 2), NPB-Ie4 (Rio). Source: the webui repo's
`cgs-devices-basic-specs` skill.

## Fields the service reads

| Field | Id | Values / note |
|---|---|---|
| Affects versions | `versions` | daily builds, e.g. `5.10.0-commit.3089`; often added after creation |
| Devices | `customfield_10033` | multi-select of products, not board types: All, NPB-All, AFS, Cuba, Dharkan, India, Kazaar, Napoli, Venezia, Ristretto, Volluto, NPB-Ie6-XL, NPB-Ie6, IOT, Rio, GLSUN Bypass |
| Attachments | `attachment` | names only are used |
| Reporter | `reporter` | `accountId` for the mention, `displayName` for the UI |
| Status, labels, description, comments, created, updated | standard | |

Other fields seen: Is it reproducible? `customfield_10054` (Yes / No / Intermittent), Bug
Classification `customfield_10316`, Verified fix version `customfield_10056`. Required on create:
only Project, Issue Type, Summary. No Environment, Steps or Severity field.

Labels in use: `WebUI`, `Web_UI_2.0`, `HA`, `stack`, `R5.10`, `R5.11`, `webui-blocked`. Components
(WebUI, Webui2.0, Web_UI_2.0) are unreliable: 14 of ~50 recent WebUI bugs carry one; the labels
are the signal, and about 11 of 60 recent WebUI bugs have neither label.

## Workflow, as used

Statuses, shared by KAZ and RPG: Created → To Do → Approved → In Progress → Ready To Test →
Testing → Done, with Failed and Deferred on the side. Transition ids are not used by the service.

- Created → QA lead hands the bug to the PM after ~15 min (median; middle half 7–42 min) → PM
  moves it to To Do, sets the developer, release label and priority. Median time in Created:
  2.4 h over the 90 days to 2026-10-26, 17 h over the year.
- A quarter of reports change after their first 3 minutes, mostly by the reporter; the last change
  comes at 22 min (median). `scripts/late-changes.ts` measures this again.
- Moving a bug between KAZ and RPG changes its key, not its id.
- The real wait is Ready To Test (median 7.8 days); Testing → Done takes minutes.
- Resolution is set on In Progress → Ready To Test, so `resolution = Unresolved` hides bugs that
  wait for testing.
- "Needs info" is a convention, not a status: label `webui-blocked` and reassign to the PO.
- Resolutions in use: Done / Fixed Bug, Cannot Reproduce, Fixed by, Done, Duplicate, Works As
  Designed, Won't Do.
