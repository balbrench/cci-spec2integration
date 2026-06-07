#!/usr/bin/env node
/* eslint-disable */
/**
 * build-reference-workflow-catalog.js
 *
 * Scans `templates/azure/reference-workflows/` and writes `catalog.json` in
 * the same directory. The catalog contains extracted metadata (trigger types,
 * action types, service-provider IDs, operationIds, managed-API references,
 * splitOn flag, action count, tags) so that the azure-logic-apps-compiler and
 * azure-connections-binder agents can do a single keyword/operationId lookup
 * instead of opening every template JSON.
 *
 * Layout assumptions
 * ──────────────────
 *   templates/azure/reference-workflows/
 *     <pattern>/workflow.json                          → category: workflow
 *     connections/<connector>/connections.json         → category: connection
 *     service-providers/<provider>/<op>/workflow.json  → category: service-provider
 *
 * Optionally each leaf folder may carry a sibling `_provenance.json`
 * (upstream/copiedAt/license/notes). When present, `provenance.upstream` is
 * surfaced on the catalog entry so consumers can trace where the snippet came
 * from without opening the file.
 *
 * Usage:  node scripts/build-reference-workflow-catalog.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'templates', 'azure', 'reference-workflows');
const CONNECTIONS_DIR = path.join(ROOT, 'connections');
const SERVICE_PROVIDERS_DIR = path.join(ROOT, 'service-providers');
const OUTPUT = path.join(ROOT, 'catalog.json');

// ── Helpers ───────────────────────────────────────────────────────────

function tryParseJson(filePath) {
    try {
        let content = fs.readFileSync(filePath, 'utf-8');
        if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
        return JSON.parse(content);
    } catch {
        return undefined;
    }
}

function readProvenance(folder) {
    const p = path.join(folder, '_provenance.json');
    if (!fs.existsSync(p)) return null;
    const json = tryParseJson(p);
    if (!json) return null;
    return {
        upstream: json.upstream || null,
        upstreamRepo: json.upstreamRepo || null,
        copiedAt: json.copiedAt || null,
    };
}

function relPosix(absPath) {
    return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function extractActionTypes(actions) {
    const types = new Set();
    if (!actions || typeof actions !== 'object') return types;
    for (const [, action] of Object.entries(actions)) {
        if (action?.type) types.add(action.type);
        if (action?.actions) for (const t of extractActionTypes(action.actions)) types.add(t);
        if (action?.else?.actions) for (const t of extractActionTypes(action.else.actions)) types.add(t);
        if (action?.cases) {
            for (const c of Object.values(action.cases)) {
                if (c?.actions) for (const t of extractActionTypes(c.actions)) types.add(t);
            }
        }
        if (action?.default?.actions) for (const t of extractActionTypes(action.default.actions)) types.add(t);
        if (action?.tools) {
            for (const tool of Object.values(action.tools)) {
                if (tool?.actions) for (const t of extractActionTypes(tool.actions)) types.add(t);
            }
        }
    }
    return types;
}

function extractServiceProviderIds(obj) {
    const ids = new Set();
    if (!obj || typeof obj !== 'object') return ids;
    for (const [, item] of Object.entries(obj)) {
        const sp = item?.inputs?.serviceProviderConfiguration;
        if (sp?.serviceProviderId) ids.add(sp.serviceProviderId);
        if (item?.actions) for (const id of extractServiceProviderIds(item.actions)) ids.add(id);
        if (item?.else?.actions) for (const id of extractServiceProviderIds(item.else.actions)) ids.add(id);
        if (item?.cases) for (const c of Object.values(item.cases)) {
            if (c?.actions) for (const id of extractServiceProviderIds(c.actions)) ids.add(id);
        }
        if (item?.default?.actions) for (const id of extractServiceProviderIds(item.default.actions)) ids.add(id);
        if (item?.tools) for (const tool of Object.values(item.tools)) {
            if (tool?.actions) for (const id of extractServiceProviderIds(tool.actions)) ids.add(id);
        }
    }
    return ids;
}

function extractOperationIds(obj) {
    const ids = new Set();
    if (!obj || typeof obj !== 'object') return ids;
    for (const [, item] of Object.entries(obj)) {
        const sp = item?.inputs?.serviceProviderConfiguration;
        if (sp?.operationId) ids.add(sp.operationId);
        if (item?.actions) for (const id of extractOperationIds(item.actions)) ids.add(id);
        if (item?.else?.actions) for (const id of extractOperationIds(item.else.actions)) ids.add(id);
        if (item?.cases) for (const c of Object.values(item.cases)) {
            if (c?.actions) for (const id of extractOperationIds(c.actions)) ids.add(id);
        }
        if (item?.default?.actions) for (const id of extractOperationIds(item.default.actions)) ids.add(id);
        if (item?.tools) for (const tool of Object.values(item.tools)) {
            if (tool?.actions) for (const id of extractOperationIds(tool.actions)) ids.add(id);
        }
    }
    return ids;
}

function extractApiConnectionRefs(actions) {
    const refs = new Set();
    if (!actions || typeof actions !== 'object') return refs;
    for (const [, action] of Object.entries(actions)) {
        const ref = action?.inputs?.host?.connection?.referenceName;
        if (ref) refs.add(ref);
        if (action?.actions) for (const r of extractApiConnectionRefs(action.actions)) refs.add(r);
        if (action?.else?.actions) for (const r of extractApiConnectionRefs(action.else.actions)) refs.add(r);
        if (action?.cases) for (const c of Object.values(action.cases)) {
            if (c?.actions) for (const r of extractApiConnectionRefs(c.actions)) refs.add(r);
        }
        if (action?.default?.actions) for (const r of extractApiConnectionRefs(action.default.actions)) refs.add(r);
        if (action?.tools) for (const tool of Object.values(action.tools)) {
            if (tool?.actions) for (const r of extractApiConnectionRefs(tool.actions)) refs.add(r);
        }
    }
    return refs;
}

function findWorkflowFiles(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...findWorkflowFiles(full));
        else if (e.name === 'workflow.json') out.push(full);
    }
    return out;
}

function findConnectionFiles(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...findConnectionFiles(full));
        else if (e.name === 'connections.json') out.push(full);
    }
    return out;
}

// ── Workflow entries ─────────────────────────────────────────────────

function buildWorkflowEntries() {
    const entries = [];
    const candidates = findWorkflowFiles(ROOT);
    for (const filePath of candidates) {
        const rel = relPosix(filePath);
        // Skip the connections subtree; it has no workflow.json but be defensive.
        if (rel.startsWith('connections/')) continue;

        const isServiceProvider = rel.startsWith('service-providers/');
        const json = tryParseJson(filePath);
        if (!json?.definition) continue;

        const def = json.definition;
        const folderAbs = path.dirname(filePath);
        const folder = relPosix(folderAbs);

        const triggerTypes = new Set();
        const triggerSpIds = new Set();
        const triggerOpIds = new Set();
        let hasSplitOn = false;
        if (def.triggers) {
            for (const [, t] of Object.entries(def.triggers)) {
                if (t?.type) triggerTypes.add(t.type);
                const sp = t?.inputs?.serviceProviderConfiguration;
                if (sp?.serviceProviderId) triggerSpIds.add(sp.serviceProviderId);
                if (sp?.operationId) triggerOpIds.add(sp.operationId);
                if (t?.splitOn) hasSplitOn = true;
            }
        }
        const actionTypes = extractActionTypes(def.actions);
        const allSpIds = new Set([...triggerSpIds, ...extractServiceProviderIds(def.actions)]);
        const allOpIds = new Set([...triggerOpIds, ...extractOperationIds(def.actions)]);
        const apiConnectionRefs = [...extractApiConnectionRefs(def.actions)];

        const tags = buildWorkflowTags(folder, [...triggerTypes], [...actionTypes], [...allSpIds], [...allOpIds]);

        entries.push({
            id: folder,
            category: isServiceProvider ? 'service-provider' : 'workflow',
            folder,
            path: rel,
            kind: json.kind || null,
            triggerTypes: [...triggerTypes],
            actionTypes: [...actionTypes],
            serviceProviderIds: [...allSpIds],
            operationIds: [...allOpIds],
            apiConnectionRefs,
            hasSplitOn,
            actionCount: def.actions ? Object.keys(def.actions).length : 0,
            tags,
            provenance: readProvenance(folderAbs),
        });
    }
    return entries;
}

// ── Connection entries ───────────────────────────────────────────────

function buildConnectionEntries() {
    const entries = [];
    for (const filePath of findConnectionFiles(CONNECTIONS_DIR)) {
        const json = tryParseJson(filePath);
        if (!json) continue;
        const folderAbs = path.dirname(filePath);
        const folder = relPosix(folderAbs);
        const rel = relPosix(filePath);

        const managedApis = [];
        if (json.managedApiConnections) {
            for (const [name, conn] of Object.entries(json.managedApiConnections)) {
                const apiId = conn?.api?.id || '';
                const apiType = apiId.split('/').pop() || name;
                managedApis.push({ name, apiType });
            }
        }
        const serviceProviders = [];
        if (json.serviceProviderConnections) {
            for (const [name, conn] of Object.entries(json.serviceProviderConnections)) {
                serviceProviders.push({
                    name,
                    serviceProviderId: conn?.serviceProvider?.id || '',
                    parameterSetName: conn?.parameterSetName || null,
                });
            }
        }
        const hasAgentConnections = !!json.agentConnections && Object.keys(json.agentConnections).length > 0;

        entries.push({
            id: folder,
            category: 'connection',
            folder,
            path: rel,
            managedApis,
            serviceProviders,
            hasAgentConnections,
            tags: buildConnectionTags(folder, managedApis, serviceProviders, hasAgentConnections),
            provenance: readProvenance(folderAbs),
        });
    }
    return entries;
}

// ── Tag generation ───────────────────────────────────────────────────

function tokenizeFolder(folder) {
    return folder
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[\/\-_.()[\]{}]/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2);
}

function buildWorkflowTags(folder, triggerTypes, actionTypes, spIds, opIds) {
    const tags = new Set(tokenizeFolder(folder));
    for (const t of triggerTypes) tags.add(t.toLowerCase());
    for (const t of actionTypes) tags.add(t.toLowerCase());
    for (const spId of spIds) {
        const last = spId.split('/').pop();
        if (last) tags.add(last.toLowerCase());
    }
    for (const op of opIds) tags.add(op.toLowerCase());

    if (actionTypes.includes('Foreach') || actionTypes.includes('Until')) tags.add('loop');
    if (actionTypes.includes('If') || actionTypes.includes('Switch')) tags.add('branching');
    if (actionTypes.includes('InitializeVariable') || actionTypes.includes('SetVariable')) tags.add('variables');
    if (actionTypes.some((t) => t.toLowerCase().includes('xml'))) { tags.add('xml'); tags.add('transform'); }
    if (actionTypes.some((t) => t.toLowerCase().includes('json') || t === 'ParseJson')) tags.add('json');
    if (actionTypes.some((t) => t.toLowerCase().includes('flatfile'))) { tags.add('flat-file'); tags.add('edi'); }
    if (actionTypes.includes('Liquid')) tags.add('liquid');
    if (actionTypes.includes('Xslt')) { tags.add('xslt'); tags.add('transform'); }
    if (actionTypes.includes('Agent')) { tags.add('ai'); tags.add('agent'); }
    if (actionTypes.includes('CSharpScriptCode') || actionTypes.includes('CSharpScript') || actionTypes.includes('JavaScriptCode')) tags.add('script');
    if (triggerTypes.includes('Recurrence')) { tags.add('timer'); tags.add('scheduled'); }
    if (triggerTypes.includes('Request')) tags.add('http');
    return [...tags];
}

function buildConnectionTags(folder, managedApis, serviceProviders, hasAgentConnections) {
    const tags = new Set(tokenizeFolder(folder));
    for (const api of managedApis) { tags.add(api.apiType.toLowerCase()); tags.add('managed-api'); }
    for (const sp of serviceProviders) {
        const last = (sp.serviceProviderId || '').split('/').pop();
        if (last) tags.add(last.toLowerCase());
        tags.add('service-provider');
    }
    if (hasAgentConnections) { tags.add('agent'); tags.add('ai'); }
    return [...tags];
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
    if (!fs.existsSync(ROOT)) {
        console.error(`reference-workflows root not found: ${ROOT}`);
        process.exit(1);
    }
    const workflows = buildWorkflowEntries();
    const connections = buildConnectionEntries();

    const sortKey = (e) => `${e.category}:${e.folder}`;
    const entries = [...workflows, ...connections].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

    const catalog = {
        version: 1,
        generatedAt: new Date().toISOString(),
        totalEntries: entries.length,
        countsByCategory: entries.reduce((acc, e) => { acc[e.category] = (acc[e.category] || 0) + 1; return acc; }, {}),
        entries,
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(catalog, null, 2), 'utf-8');
    console.log(`Catalog written: ${OUTPUT}`);
    console.log(`  total entries:   ${catalog.totalEntries}`);
    for (const [cat, n] of Object.entries(catalog.countsByCategory)) {
        console.log(`  ${cat.padEnd(18)} ${n}`);
    }
    console.log(`  file size:       ${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB`);
}

main();
