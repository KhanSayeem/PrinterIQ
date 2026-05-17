# /fix-issue

Work a GitHub issue from start to merged PR.

## Usage

```
/fix-issue 5
```

## Steps

1. **Read the issue**
   ```
   gh issue view $ISSUE_NUMBER
   ```
   Read every acceptance criterion before writing a line of code.

2. **Check out a branch**
   ```
   git checkout dev && git pull origin dev
   git checkout -b feat/issue-$ISSUE_NUMBER-<short-slug>
   ```

3. **Read the PRD section** relevant to this issue before implementing.
   The PRD is at `PrinterIQ_PRD_v1.0.md` — it is the authoritative source.

4. **TDD — red first**
   Write the failing test(s) that match the acceptance criteria.
   Run them: they must fail before you write implementation code.

5. **Green — implement until tests pass**
   Write the minimum implementation to make tests pass.
   Do not write code without a failing test first.

6. **Refactor**
   Clean up without changing behaviour. Tests must still pass.

7. **Security + DB review**
   - If you wrote auth, payment, or webhook code: invoke `.claude/agents/security-reviewer.md`
   - If you wrote any DB query: invoke `.claude/agents/db-reviewer.md`

8. **Commit and push**
   ```
   git add <specific files>
   git commit -m "feat(issue-$ISSUE_NUMBER): <description>"
   git push -u origin feat/issue-$ISSUE_NUMBER-<short-slug>
   ```

9. **Open PR**
   ```
   gh pr create --base dev --title "..." --body "Closes #$ISSUE_NUMBER"
   ```
   Include the acceptance criteria checklist in the PR body.
