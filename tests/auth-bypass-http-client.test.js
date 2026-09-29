'use strict';

// AUTH-BYPASS — client calls are not routes; FastAPI dependencies are auth
// (issue #842, DR-4).
//
// DavenRoe (ccantynz-alt/davenroe.com @ 1dea3658): 73 authBypass errors,
// every one a frontend axios call — `api.post('/support/tickets', body)` on
// `const api = axios.create(...)` — read as an unprotected Express route.
// The server half (FastAPI, `Depends(get_current_user)`) was never graded.
// Each quiet case below has the positive control beside it, so precision
// cannot be bought by muting the rule. Run against origin/main:
//   - the axios cases fire there (the receiver `api` is on the route list);
//   - the FastAPI positive controls report nothing there (`.py` unscanned).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AuthBypass = require('../src/modules/auth-bypass');
// origin/main has neither core file: the unit cases skip there, the
// module-level cases still run and show the before/after delta.
let clientCore = null;
let pyCore = null;
try { clientCore = require('../src/core/http-client-calls'); pyCore = require('../src/core/python-routes'); } catch { /* old tree */ }

function makeResult() {
  const checks = [];
  return {
    checks,
    addCheck(id, passed, meta) { checks.push({ id, passed, meta: meta || {} }); },
    get findings() { return checks.filter((c) => !c.passed); },
    get errors() { return checks.filter((c) => !c.passed && (c.meta.severity || 'error') === 'error'); },
  };
}
async function scan(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-authbypass-client-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const result = makeResult();
    await new AuthBypass().run(result, { projectRoot: root });
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const routesOf = (r) => r.findings.map((f) => f.meta.message).join('\n');

describe('authBypass — an HTTP client call is a consumer, never a route (DR-4)', () => {
  it('QUIET: axios instance `api.post(...)` in a page component (DavenRoe Bills.jsx shape)', async () => {
    const r = await scan({
      'frontend/src/services/api.js': `
import axios from 'axios';
const api = axios.create({ baseURL: '/api/v1' });
export default api;
export const runBenfords = (amounts) => api.post('/benfords', { amounts });
`,
      'frontend/src/pages/Bills.jsx': `
import api from '../services/api';
export default function Bills() {
  const load = async () => {
    const res = await api.get('/transactions/', { params: { limit: 50 } });
    await api.post('/support/tickets', { subject: 'x' });
    return api.delete('/bills/1', { data: {} });
  };
  return null;
}
`,
    });
    assert.equal(r.findings.length, 0, routesOf(r));
  });

  it('QUIET: a bare `api.get` in a file that imports only an HTTP client library', async () => {
    const r = await scan({ 'src/client.ts': `
import ky from 'ky';
const api = ky.extend({ prefixUrl: '/api' });
api.post('/admin/users', { json: {} }).json();
` });
    assert.equal(r.findings.length, 0, routesOf(r));
  });

  it('FIRES: `app.get("/admin", handler)` with no middleware in an express file', async () => {
    const r = await scan({ 'server/routes.js': `
const express = require('express');
const app = express();
app.get('/admin', handler);
app.post('/transactions', (req, res) => res.json(db.list()));
` });
    assert.equal(r.errors.length, 1, routesOf(r));
    assert.match(r.errors[0].meta.message, /GET \/admin/);
    assert.match(r.errors[0].meta.message, /POST \/transactions/);
  });

  it('FIRES: a router NAMED `api` is still a router — `const api = express.Router()`', async () => {
    const r = await scan({ 'server/api.js': `
const express = require('express');
const api = express.Router();
api.get('/admin/users', (req, res) => res.json(users));
module.exports = api;
` });
    assert.equal(r.errors.length, 1, routesOf(r));
  });

  it('classifier: consumed-value shapes vs statement-level registration', { skip: !clientCore && 'src/core/http-client-calls.js absent' }, () => {
    const { isHttpClientCall, callValueIsConsumed } = clientCore;
    assert.equal(callValueIsConsumed('const r = await ', ''), true);
    assert.equal(callValueIsConsumed('return ', ''), true);
    assert.equal(callValueIsConsumed('export const f = () => ', ''), true);
    assert.equal(callValueIsConsumed(';\n', ''), false);
    assert.equal(callValueIsConsumed('}\n  ', '.then(r => r)'), true);
    assert.equal(callValueIsConsumed('{\n  ', ';'), false);
    const content = "const api = axios.create({});\napi.get('/x', cfg);";
    assert.equal(isHttpClientCall({ content, masked: content, receiver: 'api', start: content.indexOf("api.get"), end: -1 }), true);
    const server = "const api = express.Router();\napi.get('/x', h);";
    assert.equal(isHttpClientCall({ content: server, masked: server, receiver: 'api', start: server.indexOf("api.get"), end: -1 }), false);
  });
});

describe('authBypass — FastAPI dependencies are auth (DR-4)', () => {
  const HEADER = 'from fastapi import APIRouter, Depends\nfrom app.auth import get_current_user\n';

  it('QUIET: `Depends(get_current_user)` on the endpoint', async () => {
    const r = await scan({ 'backend/app/api/routes/transactions.py': `${HEADER}
router = APIRouter(prefix="/transactions")

@router.get("/")
async def list_transactions(user: User = Depends(get_current_user)):
    return []

@router.post("/")
async def create_transaction(
    req: TxRequest,
    user: User = Depends(get_current_user),
):
    return req
` });
    assert.equal(r.findings.length, 0, routesOf(r));
  });

  it('FIRES: no dependency on /admin, /transactions and /users/me', async () => {
    const r = await scan({ 'backend/app/api/routes/admin.py': `${HEADER}
router = APIRouter()

@router.get("/admin")
async def admin_home():
    return {"ok": True}

@router.get("/transactions")
async def list_transactions(db=Depends(get_db)):
    return []

@router.get("/users/me")
async def me():
    return {}
` });
    assert.equal(r.errors.length, 1, routesOf(r));
    assert.match(r.errors[0].meta.message, /GET \/admin/);
    assert.match(r.errors[0].meta.message, /GET \/transactions/);
    assert.match(r.errors[0].meta.message, /GET \/users\/me/);
  });

  it('QUIET: `APIRouter(dependencies=[Depends(get_current_user)])` guards every route in the file', async () => {
    const r = await scan({ 'backend/app/api/routes/reports.py': `${HEADER}
router = APIRouter(prefix="/reports", dependencies=[Depends(get_current_user)])

@router.get("/admin")
async def admin_report():
    return {}
` });
    assert.equal(r.findings.length, 0, routesOf(r));
  });

  it('QUIET: `app.include_router(x.router, **PAID)` in main.py guards the router file (DavenRoe shape)', async () => {
    const files = {
      'backend/main.py': `
from fastapi import FastAPI, Depends
from app.api.routes import payroll, tax
from app.auth import require_active_subscription
app = FastAPI()
PAID = {"dependencies": [Depends(require_active_subscription)]}
app.include_router(payroll.router, prefix="/api/v1", **PAID)
app.include_router(tax.router, prefix="/api/v1")
`,
      'backend/app/api/routes/payroll.py': `${HEADER}
router = APIRouter(prefix="/payroll")

@router.post("/run")
async def run_payroll(req: PayrollRequest):
    return req
`,
      'backend/app/api/routes/tax.py': `${HEADER}
router = APIRouter(prefix="/tax")

@router.post("/file")
async def file_return(req: TaxRequest):
    return req
`,
    };
    const r = await scan(files);
    assert.equal(r.errors.length, 1, routesOf(r));
    assert.match(r.errors[0].meta.message, /tax\.py/, 'only the router included WITHOUT dependencies is unprotected');
    if (pyCore) assert.deepEqual([...pyCore.appLevelProtectedRouters([{ content: files['backend/main.py'] }])], ['payroll']);
  });

  it('QUIET: a handler that declares itself public, and `# auth-public`', async () => {
    const r = await scan({ 'backend/app/api/routes/support.py': `${HEADER}
router = APIRouter(prefix="/support")

@router.post("/contact")
async def public_contact(req: ContactRequest):
    return {}

@router.post("/ask")
async def ask(req: AskRequest):
    """Public version (no login) — limited to 3 questions per IP per hour."""
    return {}

@router.get("/articles")
async def articles(
    q: str = Query(None),
    limit: int = Query(20),
):
    """Search the knowledge base. No authentication required."""
    return []

# auth-public — the pricing page reads this
@router.get("/plans")
async def plans():
    return {}
` });
    assert.equal(r.findings.length, 0, routesOf(r));
  });

  it('FIRES: a docstring that merely mentions the word later is not a declaration', { skip: !pyCore && 'src/core/python-routes.js absent' }, () => {
    const routes = pyCore.findPythonRoutes(`from fastapi import APIRouter
router = APIRouter()

@router.get("/admin")
async def admin():
    """Admin dashboard. Data here is not public."""
    return {}

@router.get("/admin/users")
async def users():
    """List users. Without authentication this returns 401 upstream."""
    return {}
`);
    assert.equal(routes.length, 2);
    assert.equal(routes[1].protectedBy, null, 'a bare "without authentication" is not a declaration');
    assert.equal(routes[0].protectedBy, null);
  });

  it('QUIET: a Python file without a web-framework import is not a route file', async () => {
    const r = await scan({ 'lib/client.py': `
import requests
router = Client()

@router.get("/admin")
def admin():
    return 1
` });
    assert.equal(r.findings.length, 0, routesOf(r));
  });

  it('Flask: `@login_required` is auth; a bare `@bp.route(..., methods=["POST"])` fires', async () => {
    const r = await scan({ 'app/views.py': `
from flask import Blueprint
from flask_login import login_required
bp = Blueprint("admin", __name__, url_prefix="/admin")

@bp.route("/users", methods=["POST"])
@login_required
def create_user():
    return "ok"

@bp.route("/settings", methods=["POST"])
def settings():
    return "ok"
` });
    assert.equal(r.errors.length, 1, routesOf(r));
    assert.match(r.errors[0].meta.message, /POST \/admin\/settings/);
    assert.doesNotMatch(r.errors[0].meta.message, /\/admin\/users/);
  });
});
