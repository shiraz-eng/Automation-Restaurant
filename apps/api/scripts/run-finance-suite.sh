#!/usr/bin/env bash
# Finance Phase H — run every finance test suite against every reachable
# restaurant project. Each DB suite is one rolled-back transaction.
# Usage (from apps/api):  bash scripts/run-finance-suite.sh [ref ...]
REFS=("$@")
[ ${#REFS[@]} -eq 0 ] && REFS=(iwccsyjuplkwaxswpgyw uhfwoftjecgjemvwqdbp yloyvprgdkthzfcfbhrm qmeorneaiodipuhcyqhm ornkhhbehjigerfvmzlp)
SUITES=(test-finance-hardening test-financial-ledger test-expense-workflow test-invoice-matching test-day-close test-finance-overview test-finance-scenario test-performance-access)
total_fail=0
for ref in "${REFS[@]}"; do
  for s in "${SUITES[@]}"; do
    [ -f "scripts/$s.ts" ] || continue
    out=$(npx tsx "scripts/$s.ts" "$ref" 2>&1); code=$?
    pass=$(grep -c '^PASS' <<<"$out"); fail=$(grep -c '^FAIL' <<<"$out")
    if [ $code -ne 0 ] || [ "$fail" -gt 0 ]; then
      total_fail=$((total_fail + 1)); echo "✗ $ref $s pass=$pass fail=$fail exit=$code"; grep -E '^FAIL|rror' <<<"$out" | head -8 | sed 's/^/    /'
    else echo "✓ $ref $s pass=$pass"; fi
  done
done
out=$(npx tsx scripts/test-supplier-invoice-import.ts 2>&1); code=$?
echo "$( [ $code -eq 0 ] && echo ✓ || echo ✗ ) (no tenant) test-supplier-invoice-import pass=$(grep -c '^PASS' <<<"$out") fail=$(grep -c '^FAIL' <<<"$out")"
[ $code -ne 0 ] && total_fail=$((total_fail + 1))
out=$(npx tsx scripts/test-tenant-isolation.ts 2>&1); code=$?
echo "$( [ $code -eq 0 ] && echo ✓ || echo ✗ ) (all restaurants, live API) test-tenant-isolation pass=$(grep -c '^PASS' <<<"$out") fail=$(grep -c '^FAIL' <<<"$out")"
[ $code -ne 0 ] && { total_fail=$((total_fail + 1)); grep '^FAIL' <<<"$out" | head -8 | sed 's/^/    /'; }
echo "suites failing: $total_fail"
exit $total_fail
