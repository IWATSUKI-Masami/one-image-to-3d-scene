/**
 * Reports of an Arrange run, for evaluation and papers: a text report, a CSV of the
 * objects (photo match and warnings before and after), a CSV of the rounds and API
 * calls (metrics, tokens, times), and an image sheet of the renderings of every round.
 * They are built from the record that the run fills as it goes, so a failed or
 * cancelled run still has its data.
 */
import { ARRANGE_PROVIDER_LABELS } from './arrangeProviders';
import type { ArrangeObject, ArrangeRecord } from './semanticArrange';
import { compareAnalysis } from './sceneAnalysis';

/**
 * List prices (USD per million tokens: input, output) used for the cost estimate.
 * Only models whose prices are known here; other models get no cost (tokens are
 * always reported). Cache discounts are not taken into account.
 */
const PRICES: Record<string, [number, number]> = {
    'claude-opus-5-5': [4, 20],
    'claude-opus-5': [5, 25],
    'claude-fable-5-2': [8, 40],
    'claude-fable-5-1': [10, 50],
    'claude-sonnet-5-5': [2, 10],
    'claude-sonnet-5': [2, 10],
    'claude-haiku-5-5': [0.1, 0.5],
};

export interface ArrangeTotals {
    elapsedS: number;
    /** Time waiting for the API (sum over the calls) and the rest (rendering, measuring, applying) */
    apiS: number;
    localS: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    /** Estimated cost in USD at list prices (undefined when the model's price is not known) */
    costUsd?: number;
}

export interface ArrangeReportInput {
    record: ArrangeRecord;
    sceneName?: string;
    outcome: 'done' | 'failed' | 'cancelled';
    endedAt: number;
    summary?: string;
    /** Objects before and after (from the result; for a failed run, from the record) */
    objectsBefore?: ArrangeObject[];
    objectsAfter?: ArrangeObject[];
    log: string[];
}

const f = (v: number | undefined, digits = 3) => v === undefined || Number.isNaN(v) ? '-' : v.toFixed(digits);
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const mmss = (sec: number) => { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export const arrangeTotals = (record: ArrangeRecord, endedAt: number): ArrangeTotals => {
    const elapsedS = (endedAt - record.startedAt) / 1000;
    const apiS = record.calls.reduce((s, c) => s + c.durationMs, 0) / 1000;
    const inputTokens = record.calls.reduce((s, c) => s + c.usage.input, 0);
    const outputTokens = record.calls.reduce((s, c) => s + c.usage.output, 0);
    const reasoningTokens = record.calls.reduce((s, c) => s + (c.usage.reasoning ?? 0), 0);
    const price = PRICES[record.settings.model];
    return {
        elapsedS, apiS, localS: Math.max(0, elapsedS - apiS), calls: record.calls.length,
        inputTokens, outputTokens, reasoningTokens,
        costUsd: price ? (inputTokens * price[0] + outputTokens * price[1]) / 1e6 : undefined,
    };
};

export const buildArrangeReport = (r: ArrangeReportInput) => {
    const { record, outcome, endedAt } = r;
    const s = record.settings;
    const totals = arrangeTotals(record, endedAt);
    const providerName = `${ARRANGE_PROVIDER_LABELS[s.provider]} (${s.model})`;
    const lastRound = record.rounds[record.rounds.length - 1];
    const before = record.initial;
    const after = lastRound ?? before;
    const objBefore = new Map((r.objectsBefore ?? []).map(o => [o.id, o]));
    const objectsAfter = r.objectsAfter ?? [];
    const rows = objectsAfter.map(o => ({
        id: o.id, label: o.label, before: objBefore.get(o.id)?.photoMatch, after: o.photoMatch,
        warningsBefore: objBefore.get(o.id)?.warnings ?? [], warningsAfter: o.warnings ?? [],
        propBefore: objBefore.get(o.id)?.proportionChange, propAfter: o.proportionChange,
        relBefore: objBefore.get(o.id)?.relationWarnings ?? [], relAfter: o.relationWarnings ?? [],
    }));
    const a = record.analysis;
    const rel = (v: number | undefined) => v === undefined ? '-' : String(v);
    const ref = record.reference;
    const cmp = a && ref ? compareAnalysis(a, ref) : undefined;
    const pct = (v: number | undefined) => v === undefined ? '-' : `${Math.round(v * 100)}%`;
    const refWarn = (warnings: Record<string, string[]> | undefined, id: string) => warnings?.[id] ?? [];

    const text = [
        'Arrange report',
        `Scene: ${r.sceneName ?? ''}`,
        `Provider: ${providerName}`,
        `Settings: effort ${s.effort}, at most ${s.maxRounds} rounds, prompt version ${s.promptVersion}, app ${s.appVersion}`,
        `Started: ${new Date(record.startedAt).toISOString()}`,
        `Ended: ${new Date(endedAt).toISOString()} (elapsed ${mmss(totals.elapsedS)})`,
        `Outcome: ${outcome}, rounds: ${record.rounds.length}`,
        `Photo match (mean IoU with the photo masks): ${f(before?.meanIoU)} -> ${f(after?.meanIoU)}`,
        `Physical issues (floating, sunk, inside another model): ${before?.issues ?? '-'} -> ${after?.issues ?? '-'}`,
        `Relation issues (relations and sizes of the scene analysis not satisfied): ${rel(before?.relationIssues)} -> ${rel(after?.relationIssues)}`,
        ...(ref ? [`Relation issues against the reference analysis (${ref.fileName ?? 'checked by a person'}): ${rel(before?.refRelationIssues)} -> ${rel(after?.refRelationIssues)}`] : []),
        ...(cmp ? [`Analysis vs reference: relations found ${cmp.found}/${cmp.reference} (recall ${pct(cmp.recall)}), correct ${cmp.correct}/${cmp.given} (precision ${pct(cmp.precision)}), contact visibility right ${cmp.contactRight}/${cmp.contactTotal}, mean height error ${pct(cmp.heightError)}`] : []),
        ...(r.summary ? ['', `Summary: ${r.summary}`] : []),
        '',
        'Time:',
        `  total ${f(totals.elapsedS, 1)} s = API ${f(totals.apiS, 1)} s (${totals.calls} calls) + local ${f(totals.localS, 1)} s (rendering, measuring, applying)`,
        ...record.calls.map(c => `  call ${c.index}: started ${f(c.startMs / 1000, 1)} s, ${f(c.durationMs / 1000, 1)} s, tokens in ${c.usage.input} / out ${c.usage.output}${c.usage.reasoning ? ` (reasoning ${c.usage.reasoning})` : ''}${c.usage.cacheRead ? `, cache read ${c.usage.cacheRead}` : ''}, tools: ${c.tools.join(', ') || 'none'}${c.model ? `, model ${c.model}` : ''}`),
        '',
        'Scene analysis:',
        ...(a ? [
            `  scene: ${a.scene}`,
            `  scale reference: ${a.scale_reference.ids.join(', ') || '-'} (${a.scale_reference.reason})`,
            ...a.objects.map(o => `  ${o.id}: ${o.height_m} m tall, ${o.width_m} m wide; ${o.pose}`),
            ...a.relations.map(x => `  ${x.subject} ${x.relation} ${x.object}${x.relation === 'on' || x.relation === 'sits_on' ? ` (contact ${x.contact_visible ? 'visible' : 'not visible'})` : ''}`),
            ...(a.notes ? [`  notes: ${a.notes}`] : []),
        ] : ['  none']),
        ...(cmp ? [
            '  compared with the reference:',
            `    missing: ${cmp.missing.join('; ') || 'none'}`,
            `    not in the reference: ${cmp.extra.join('; ') || 'none'}`,
            `    heights (model / reference, m): ${cmp.heights.map(h => `${h.id} ${h.model}/${h.reference}`).join(', ')}`,
        ] : []),
        ...(record.analysisRaw !== undefined && (!a || a.objects.length === 0) ? [`  as sent by the model: ${JSON.stringify(record.analysisRaw)}`] : []),
        '',
        'Tokens and cost:',
        `  input ${totals.inputTokens}, output ${totals.outputTokens}${totals.reasoningTokens ? ` (reasoning ${totals.reasoningTokens})` : ''}`,
        `  estimated cost: ${totals.costUsd !== undefined ? `$${totals.costUsd.toFixed(3)} at list prices (cache discounts not included)` : 'not known for this model (see the token counts)'}`,
        '',
        'Rounds (mean IoU, physical issues, relation issues, times in ms: apply / render / measure):',
        ...(before ? [`  round 0 (before): IoU ${f(before.meanIoU)}, issues ${before.issues}, relations ${rel(before.relationIssues)}, render ${before.renderMs.toFixed(0)}, measure ${before.measureMs.toFixed(0)}`] : []),
        ...record.rounds.map(rd => `  round ${rd.round} (call ${rd.call}): IoU ${f(rd.meanIoU)}, issues ${rd.issues}, relations ${rel(rd.relationIssues)}, ${rd.applyMs} / ${rd.renderMs} / ${rd.measureMs}; ${rd.reason}`),
        '',
        'Edits per round (as requested by the model):',
        ...record.rounds.flatMap(rd => [
            `  round ${rd.round}:`,
            ...rd.edits.map(e => `    ${JSON.stringify(e)}`),
            ...(rd.problems.length ? [`    problems: ${rd.problems.join('; ')}`] : []),
        ]),
        '',
        'Photo match per object (IoU before -> after; area ratio before -> after):',
        ...rows.map(o => `  ${o.id} ${o.label}: ${f(o.before?.iou)} -> ${f(o.after?.iou)}; ${f(o.before?.areaRatio)} -> ${f(o.after?.areaRatio)}`),
        '',
        'Proportion change per object (largest relative difference of the axis scales from the generated model; 0 = unchanged):',
        ...rows.map(o => `  ${o.id} ${o.label}: ${f(o.propBefore)} -> ${f(o.propAfter)}`),
        '',
        'Physical warnings per object (before -> after):',
        ...rows.map(o => `  ${o.id} ${o.label}: ${o.warningsBefore.join('; ') || 'none'} -> ${o.warningsAfter.join('; ') || 'none'}`),
        '',
        'Relation warnings per object (before -> after):',
        ...rows.map(o => `  ${o.id} ${o.label}: ${o.relBefore.join('; ') || 'none'} -> ${o.relAfter.join('; ') || 'none'}`),
        '',
        ...(ref ? [
            'Relation warnings against the reference analysis per object (before -> after):',
            ...rows.map(o => `  ${o.id} ${o.label}: ${refWarn(before?.refRelationWarnings, o.id).join('; ') || 'none'} -> ${refWarn(after?.refRelationWarnings, o.id).join('; ') || 'none'}`),
            '',
        ] : []),
        'Log:',
        ...r.log,
    ].join('\n');

    const header = [
        `scene,${q(r.sceneName ?? '')}`,
        `provider,${q(providerName)}`,
        `effort,${s.effort}`,
        `max_rounds,${s.maxRounds}`,
        `prompt_version,${s.promptVersion}`,
        `app_version,${q(s.appVersion)}`,
        `started_at,${new Date(record.startedAt).toISOString()}`,
        `outcome,${outcome}`,
        `rounds,${record.rounds.length}`,
        `elapsed_s,${f(totals.elapsedS, 1)}`,
        `api_s,${f(totals.apiS, 1)}`,
        `local_s,${f(totals.localS, 1)}`,
        `api_calls,${totals.calls}`,
        `input_tokens,${totals.inputTokens}`,
        `output_tokens,${totals.outputTokens}`,
        `reasoning_tokens,${totals.reasoningTokens}`,
        `cost_usd,${totals.costUsd !== undefined ? totals.costUsd.toFixed(4) : ''}`,
        `mean_iou,${f(before?.meanIoU)},${f(after?.meanIoU)}`,
        `physical_issues,${before?.issues ?? ''},${after?.issues ?? ''}`,
        `relation_issues,${before?.relationIssues ?? ''},${after?.relationIssues ?? ''}`,
        `analysis_relations,${a?.relations.length ?? ''}`,
        `reference,${q(ref?.fileName ?? '')}`,
        `ref_relation_issues,${before?.refRelationIssues ?? ''},${after?.refRelationIssues ?? ''}`,
        `analysis_recall,${cmp?.recall !== undefined ? cmp.recall.toFixed(3) : ''},${cmp ? `${cmp.found}/${cmp.reference}` : ''}`,
        `analysis_precision,${cmp?.precision !== undefined ? cmp.precision.toFixed(3) : ''},${cmp ? `${cmp.correct}/${cmp.given}` : ''}`,
        `analysis_contact_visibility,${cmp ? `${cmp.contactRight}/${cmp.contactTotal}` : ''}`,
        `analysis_height_error,${cmp?.heightError !== undefined ? cmp.heightError.toFixed(3) : ''}`,
    ];

    const objectsCsv = [
        ...header,
        '',
        'object,iou_before,iou_after,area_ratio_before,area_ratio_after,offset_x_before,offset_y_before,offset_x_after,offset_y_after,proportion_change_before,proportion_change_after,warnings_before,warnings_after,relation_warnings_before,relation_warnings_after,ref_relation_warnings_before,ref_relation_warnings_after',
        ...rows.map(o => [q(o.label), f(o.before?.iou), f(o.after?.iou), f(o.before?.areaRatio), f(o.after?.areaRatio),
            f(o.before?.offset[0]), f(o.before?.offset[1]), f(o.after?.offset[0]), f(o.after?.offset[1]),
            f(o.propBefore), f(o.propAfter),
            q(o.warningsBefore.join('; ')), q(o.warningsAfter.join('; ')), q(o.relBefore.join('; ')), q(o.relAfter.join('; ')),
            q(refWarn(before?.refRelationWarnings, o.id).join('; ')), q(refWarn(after?.refRelationWarnings, o.id).join('; '))].join(',')),
        `mean,${f(before?.meanIoU)},${f(after?.meanIoU)},,,,,,,,,,,,,,`,
    ].join('\n');

    // Rounds (with the API call that requested each), then all API calls
    const callOf = new Map(record.calls.map(c => [c.index, c]));
    const maxProp = (objs: { proportionChange?: number }[]) => Math.max(0, ...objs.map(o => o.proportionChange ?? 0));
    const objectIds = (before?.objects ?? []).map(o => o.id);
    const roundsCsv = [
        ...header,
        '',
        ['round', 'call', 'api_s', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'apply_ms', 'render_ms', 'measure_ms', 'mean_iou', 'physical_issues', 'relation_issues', 'ref_relation_issues', 'max_proportion_change', 'edits',
            ...objectIds.map(id => `iou_${id}`), 'reason'].join(','),
        ...(before ? [['0', '', '', '', '', '', '', before.renderMs.toFixed(0), before.measureMs.toFixed(0), f(before.meanIoU), before.issues, before.relationIssues ?? '', before.refRelationIssues ?? '', f(maxProp(before.objects)), 0,
            ...objectIds.map(id => f(before.objects.find(o => o.id === id)?.iou)), q('before')].join(',')] : []),
        ...record.rounds.map(rd => {
            const c = callOf.get(rd.call);
            return [rd.round, rd.call, c ? f(c.durationMs / 1000, 1) : '', c?.usage.input ?? '', c?.usage.output ?? '', c?.usage.reasoning ?? '',
                rd.applyMs, rd.renderMs, rd.measureMs, f(rd.meanIoU), rd.issues, rd.relationIssues ?? '', rd.refRelationIssues ?? '', f(maxProp(rd.objects)), rd.edits.length,
                ...objectIds.map(id => f(rd.objects.find(o => o.id === id)?.iou)), q(rd.reason)].join(',');
        }),
        '',
        'call,started_s,duration_s,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,tools,model',
        ...record.calls.map(c => [c.index, f(c.startMs / 1000, 1), f(c.durationMs / 1000, 1), c.usage.input, c.usage.output, c.usage.reasoning ?? '', c.usage.cacheRead ?? '',
            q(c.tools.join(' ')), q(c.model ?? '')].join(',')),
    ].join('\n');

    return { text, objectsCsv, roundsCsv, totals };
};

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
});

/**
 * One PNG with the photo and, for every round (0 = before), the three renderings the
 * model saw (photo view, top view, oblique view), labelled with the round's metrics.
 */
export const buildArrangeImageSheet = async (record: ArrangeRecord, title: string): Promise<string | undefined> => {
    const before = record.initial;
    if (!before) return undefined;
    const rows = [
        { label: `Round 0 (before): IoU ${f(before.meanIoU)}, issues ${before.issues}${before.relationIssues !== undefined ? `, relations ${before.relationIssues}` : ''}`, images: before.images },
        ...record.rounds.map(rd => ({ label: `Round ${rd.round}: IoU ${f(rd.meanIoU)}, issues ${rd.issues}${rd.relationIssues !== undefined ? `, relations ${rd.relationIssues}` : ''}`, images: rd.images })),
    ];
    const jpg = (b64: string) => `data:image/jpeg;base64,${b64}`;
    const photo = record.photo ? await loadImage(jpg(record.photo)) : undefined;
    const loaded = await Promise.all(rows.map(async r => [await loadImage(jpg(r.images.photo)), await loadImage(jpg(r.images.top)), await loadImage(jpg(r.images.oblique))]));
    const cell = 360, gap = 8, labelH = 26;
    const photoH = photo ? Math.round(cell * photo.height / photo.width) : 0;
    const viewH = (img: HTMLImageElement) => Math.round(cell * img.height / img.width);
    const rowH = Math.max(...loaded.map(r => Math.max(...r.map(viewH)))) + labelH;
    const W = gap + 3 * (cell + gap);
    const H = 40 + (photo ? photoH + labelH + gap : 0) + rows.length * (rowH + gap);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 18px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, gap, 20);
    let y = 40;
    ctx.font = '14px sans-serif';
    if (photo) {
        ctx.fillText('Photo', gap, y + labelH / 2);
        ctx.drawImage(photo, gap, y + labelH, cell, photoH);
        ctx.fillText('Columns: photo view, top view, oblique view', gap + cell + gap, y + labelH / 2);
        y += labelH + photoH + gap;
    }
    rows.forEach((row, i) => {
        ctx.fillStyle = '#111';
        ctx.fillText(row.label, gap, y + labelH / 2);
        loaded[i].forEach((img, k) => ctx.drawImage(img, gap + k * (cell + gap), y + labelH, cell, viewH(img)));
        y += rowH + gap;
    });
    return c.toDataURL('image/png');
};
