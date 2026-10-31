const VALID_RISKS = new Set(['low', 'medium', 'high', 'critical']);
const BASE_MINIMUM = 6;

function independenceGroup(model) {
  return model.independence_group ?? model.provider_id ?? model.id;
}

function eligibleModels(task, registry) {
  if (!Array.isArray(registry)) throw new TypeError('registry must be an array');
  const risk = task?.risk ?? 'medium';
  if (!VALID_RISKS.has(risk)) throw new TypeError(`invalid risk: ${risk}`);
  const required = new Set(task?.required_capabilities ?? []);

  const candidates = registry.filter(model =>
    (model?.id || (model?.provider_id && model?.model_id)) &&
    Array.isArray(model.capabilities) &&
    [...required].every(capability => model.capabilities.includes(capability)) &&
    Array.isArray(model.risk_levels) &&
    model.risk_levels.includes(risk) &&
    (model.availability === undefined || model.availability === 'ACTIVE') &&
    (model.provenance === undefined || model.provenance === 'VERIFIED') &&
    (model.integrity === undefined || model.integrity === 'VERIFIED') &&
    (model.health === undefined || model.health === 'HEALTHY') &&
    (model.freshness === undefined || model.freshness !== 'STALE')
  );

  const independent = [];
  const groups = new Set();
  for (const model of candidates) {
    const group = independenceGroup(model);
    if (groups.has(group)) continue;
    groups.add(group);
    independent.push(model);
  }
  return independent;
}

function selectWithSpecialistCoverage(eligible, target, requiredRoles) {
  const ranked = [...eligible].sort((a, b) =>
    (b.reliability ?? 0) - (a.reliability ?? 0) ||
    String(a.model_id ?? a.id).localeCompare(String(b.model_id ?? b.id))
  );
  const selected = ranked.slice(0, target);
  const selectedGroups = new Set(selected.map(independenceGroup));

  for (const role of requiredRoles) {
    if (selected.some(model => model.specialist_roles?.includes(role))) continue;

    const replacement = ranked.find(model =>
      model.specialist_roles?.includes(role) &&
      !selectedGroups.has(independenceGroup(model))
    );
    if (!replacement) {
      throw new Error(`required specialist role cannot be independently represented: ${role}`);
    }

    const replaceIndex = selected.findIndex(model =>
      ![...requiredRoles].some(requiredRole => model.specialist_roles?.includes(requiredRole))
    );
    if (replaceIndex < 0) {
      throw new Error(`required specialist role cannot be represented within target pool: ${role}`);
    }

    selectedGroups.delete(independenceGroup(selected[replaceIndex]));
    selected[replaceIndex] = replacement;
    selectedGroups.add(independenceGroup(replacement));
  }

  return selected;
}

export function planModelPool(task, registry, signals = {}) {
  if (!task || typeof task !== 'object') throw new TypeError('task is required');

  const minimum = Math.max(BASE_MINIMUM, Number(task.model_pool?.minimum ?? BASE_MINIMUM));
  const configuredMaximum = Number(task.model_pool?.maximum);
  const maximum = Number.isFinite(configuredMaximum)
    ? Math.max(minimum, configuredMaximum)
    : Number.POSITIVE_INFINITY;

  const eligible = eligibleModels(task, registry);
  const requiredSpecialistRoles = new Set(task.required_specialist_roles ?? []);
  for (const role of requiredSpecialistRoles) {
    if (!eligible.some(model => model.specialist_roles?.includes(role))) {
      throw new Error(`required specialist role is not available in the qualified pool: ${role}`);
    }
  }
  if (eligible.length < minimum) {
    throw new Error(`minimum qualified model pool of 6 is not available; qualified=${eligible.length}`);
  }

  let target = minimum;
  const disagreement = Number(signals.disagreement ?? 0);
  if (disagreement >= 0.5) target += 2;
  if (signals.evidence_conflict === true) target += 2;
  if ((task.risk ?? 'medium') === 'critical') target += 2;
  if (Number.isInteger(task.model_pool?.required_count)) {
    target = Math.max(target, task.model_pool.required_count);
  }

  target = Math.min(target, maximum, eligible.length);
  const selected = selectWithSpecialistCoverage(eligible, target, requiredSpecialistRoles);

  return {
    minimum_models: minimum,
    maximum_models: Number.isFinite(maximum) ? maximum : null,
    target_models: selected.length,
    expanded: selected.length > minimum,
    independence_groups: selected.map(independenceGroup),
    specialist_roles: [...new Set(selected.flatMap(model => model.specialist_roles ?? []))],
    expansion_reasons: [
      ...(disagreement >= 0.5 ? ['MODEL_DISAGREEMENT'] : []),
      ...(signals.evidence_conflict === true ? ['EVIDENCE_CONFLICT'] : []),
      ...((task.risk ?? 'medium') === 'critical' ? ['CRITICAL_RISK'] : []),
      ...(Number.isInteger(task.model_pool?.required_count) && task.model_pool.required_count > minimum
        ? ['EXPLICIT_REQUIRED_COUNT'] : []),
    ],
    selected,
  };
}
