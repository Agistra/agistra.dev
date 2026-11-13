# Findings File

Every audit writes `findings.json` next to the human report, one record per candidate, including
rejected ones. Run the validator from `SKILL.md` (Verify Before Reporting) before reporting.

## Record fields

| Field | Required for | Rule |
| --- | --- | --- |
| `id` | all | Unique string; matches the `#` column in the report table |
| `category` | all | One of the category slugs listed in `SKILL.md` |
| `location` | all | `{ "file": "<path>", "line": <positive integer> }`; for a config key, the line of the key |
| `evidence` | all | The quoted code, config, or tool output |
| `verdict` | all | `confirmed`, `needs-validation`, or `rejected` |
| `severity` | `confirmed` only | `Critical`, `Required`, `Nit`, `Optional`, or `FYI`; omit it on the other verdicts |
| `unresolvedFact` | `needs-validation` | The exact fact that is still unknown |
| `reason` | `rejected` | Why the candidate is a false positive |

## Example

```json
{
	"findings": [
		{
			"id": "1",
			"category": "injection",
			"location": { "file": "src/users.js", "line": 42 },
			"evidence": "run(\"SELECT ... \" + id)",
			"verdict": "confirmed",
			"severity": "Critical"
		},
		{
			"id": "2",
			"category": "auth-backdoor",
			"location": { "file": "server/login.js", "line": 88 },
			"evidence": "if (process.env.DEBUG_LOGIN) return true;",
			"verdict": "needs-validation",
			"unresolvedFact": "Whether DEBUG_LOGIN is set in any deployed environment"
		}
	]
}
```

## What the validator checks

- Required fields per verdict are present and non-empty.
- A `needs-validation` or `rejected` record has no severity.
- The report table (the one with `#` and `Verdict` columns) and the file have the same ids and the
  same verdict for each id.

Exit code 0 means valid, 1 means problems (listed on stderr), 2 means unreadable input or bad usage.
