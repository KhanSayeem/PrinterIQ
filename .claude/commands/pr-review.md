# /pr-review

Fresh-context code review of a PR. Run this in a new conversation to avoid anchoring bias.

## Usage

```
/pr-review 15
```

## Steps

1. **Fetch the PR diff**
   ```
   gh pr diff $PR_NUMBER
   gh pr view $PR_NUMBER
   ```

2. **Read the linked issue** (find it in the PR body — `Closes #N`)
   ```
   gh issue view $ISSUE_NUMBER
   ```

3. **Check every acceptance criterion** — verify each one is met by the diff.

4. **Review for:**
   - [ ] `tenant_id` scoping on every DB query (invoke `db-reviewer` if any queries)
   - [ ] Security invariants if auth/payment/webhook code is present (invoke `security-reviewer`)
   - [ ] Lead status state machine is not violated
   - [ ] No prompt strings inline — all prompts loaded from `prompts/*.txt`
   - [ ] All Claude calls go through `claude_client.py` or `claude_agent.ts`
   - [ ] Tests exist for all TDD-mandatory paths
   - [ ] No secrets or PII in code or logs
   - [ ] TypeScript: strict mode respected, no `any` types
   - [ ] Python: mypy strict types respected

5. **Report findings** with file:line and severity (blocking / non-blocking).

6. If the review passes: approve with `gh pr review $PR_NUMBER --approve`.
   If blocking issues: request changes with `gh pr review $PR_NUMBER --request-changes --body "..."`.
