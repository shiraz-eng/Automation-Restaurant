// Unit checks for the branch rules on portal create / edit (routes/portals.ts).
// A login limited to some branches may only create or manage portals inside its own
// branches; the owner may pick any real branch, or none (= every branch).
//   npx tsx scripts/test-portal-branches.ts
import type { Request } from 'express';
import { resolvePortalBranches, withinBranches } from '../src/routes/portals';

const DHA = '11111111-1111-4111-8111-111111111111';
const CLF = '22222222-2222-4222-8222-222222222222';
const MAIN = '33333333-3333-4333-8333-333333333333';
const GONE = '44444444-4444-4444-8444-444444444444';
const REAL = [DHA, CLF, MAIN];

// The restaurant's branches table, as the service client would return it.
const service = {
  from: () => ({ select: () => ({ in: async (_c: string, ids: string[]) => ({ data: ids.filter((i) => REAL.includes(i)).map((id) => ({ id })), error: null }) }) }),
};
const req = (allowed: string[] | null) => ({ tenant: { service, allowedBranchIds: allowed } }) as unknown as Request;

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}`}`);
}

async function main() {
  check('P1 every-branch portal is not inside one branch', !withinBranches([], [DHA]));
  check('P2 a DHA portal is inside DHA', withinBranches([DHA], [DHA]));
  check('P3 a DHA+Clifton portal is not inside DHA', !withinBranches([DHA, CLF], [DHA]));

  let r = await resolvePortalBranches(req([DHA]), undefined, true);
  check('P4 a DHA manager creating a portal gives it DHA by default', JSON.stringify(r.ids) === JSON.stringify([DHA]), r);
  r = await resolvePortalBranches(req([DHA]), [], true);
  check('P5 a DHA manager cannot create an every-branch portal', !!r.error, r);
  r = await resolvePortalBranches(req([DHA]), [CLF], true);
  check('P6 a DHA manager cannot create a Clifton portal', !!r.error, r);
  r = await resolvePortalBranches(req([DHA]), [DHA, DHA], true);
  check('P7 duplicates are folded', JSON.stringify(r.ids) === JSON.stringify([DHA]), r);
  r = await resolvePortalBranches(req(null), undefined, true);
  check('P8 the owner creating a portal without branches leaves it on every branch', r.ids === undefined && !r.error, r);
  r = await resolvePortalBranches(req(null), [CLF], true);
  check('P9 the owner can create a Clifton-only portal', JSON.stringify(r.ids) === JSON.stringify([CLF]), r);
  r = await resolvePortalBranches(req(null), [GONE], true);
  check('P10 a branch that does not exist is refused', !!r.error, r);
  r = await resolvePortalBranches(req(null), undefined, false);
  check('P11 editing without branches leaves them as they are', r.ids === undefined && !r.error, r);
  r = await resolvePortalBranches(req(null), [], false);
  check('P12 the owner can widen a portal back to every branch', JSON.stringify(r.ids) === '[]', r);

  console.log(`\n${fails} failed`);
  process.exit(fails ? 1 : 0);
}
void main();
