const fs = require('fs');
const path = require('path');

const MANUAL_RISK_PATH = path.join(__dirname, '..', 'data', 'manual-risk-overrides.json');
const MANUAL_RISK_OVERRIDES = (() => {
  try {
    return JSON.parse(fs.readFileSync(MANUAL_RISK_PATH, 'utf8'));
  } catch {
    return {};
  }
})();

function yearsSince(dateText) {
  const timestamp = Date.parse(dateText);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (Date.now() - timestamp) / 31557600000);
}


function classifyCompanyRisk(registration, data) {
  const base = registration?.sources?.base || registration?.base || {};
  const reports = data.annual?.items || [];
  const hearingItems = data.hearings?.items || [];
  const riskItems = data.overview?.toolRisks || [];
  const exactCompany = (data.searchResult?.items || []).find((item) =>
    item.name === base.name && (!base.creditCode || item.creditCode === base.creditCode)
  );
  const countOf = (source) => Number(source?.total ?? source?.items?.length ?? 0) || 0;
  const isAvailable = (source) => Boolean(source && !source._error);
  const overviewCount = (...types) => riskItems
    .filter((item) => types.includes(item.riskType))
    .reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  const evidenceFrom = (source, labelKeys, valueKeys, fallback) => (source?.items || []).slice(0, 8).map((item, index) => {
    const pick = (keys) => keys.map((key) => item[key]).find((value) => value !== undefined && value !== null && value !== '');
    const format = (value) => {
      if (Array.isArray(value)) return value.map((entry) => entry?.name || entry).filter(Boolean).join('、');
      if (value && typeof value === 'object') return value.name || JSON.stringify(value);
      return String(value || '未披露');
    };
    return {
      label: format(pick(labelKeys) || `${fallback} ${index + 1}`),
      value: valueKeys.map((key) => item[key]).filter((value) => value !== undefined && value !== null && value !== '').map(format).join(' · ') || fallback
    };
  });
  const makeRule = (id, title, level, summary, reason, evidence = [], options = {}) => ({
    id,
    title,
    level,
    status: level === 'high' ? 'risk' : level === 'medium' ? 'watch' : level === 'low' ? 'good' : 'notice',
    levelLabel: level === 'high' ? '高风险' : level === 'medium' ? '中风险' : level === 'low' ? '低风险' : '核验提示',
    summary,
    reason,
    evidence: Array.isArray(evidence) ? evidence : [],
    priority: options.priority || 0,
    relatedCompanies: options.relatedCompanies || []
  });

  const manualRisk = MANUAL_RISK_OVERRIDES[base.creditCode] || MANUAL_RISK_OVERRIDES[base.name] || {};
  const suspiciousRelations = manualRisk.suspiciousRelations || {};
  const relationTypes = Array.isArray(suspiciousRelations.types) ? suspiciousRelations.types : [];
  const relationTotal = Number(suspiciousRelations.total || 0);
  const contactRelations = relationTypes.filter((item) => /电话|邮箱|手机|联系方式/.test(item.type || ''));
  const contactRelationCount = contactRelations.reduce((max, item) => Math.max(max, Number(item.count ?? relationTotal) || 0), 0);
  const suspiciousCount = Math.max(contactRelationCount, relationTotal);
  const relationLevel = suspiciousCount >= 20 ? 'high' : suspiciousCount > 0 ? 'medium' : 'low';
  const relationReason = suspiciousCount >= 20
    ? `电话、邮箱等疑似关系达到 ${suspiciousCount} 条，已达到 20 条高风险阈值，可能存在联系方式复用、挂靠或主体网络异常。`
    : suspiciousCount > 0
      ? `发现 ${suspiciousCount} 条疑似关系，未达到 20 条高风险阈值，但建议人工核对关系类型和真实业务往来。`
      : '未发现已录入的电话、邮箱等疑似关系；该项依赖天眼查页面或自有数据补充，未录入不代表绝对不存在。';

  const legalCompanies = data.personCompanies?.items || [];
  const legalTotal = Number(data.personCompanies?.total ?? legalCompanies.length) || 0;
  const closedLegalCompanies = legalCompanies.filter((item) => /注销|吊销|撤销|清算/.test(item.regStatus || item.status || ''));
  const personHighRisks = (data.personRisk?.riskGroups || []).flatMap((group) => group.risks || []).filter((item) => item.riskLevel === '高风险');
  const relatedRiskPriority = (type) => /失信/.test(type) ? 100 : /限制消费|限高/.test(type) ? 90 : /被执行/.test(type) ? 80 : /终本/.test(type) ? 70 : /破产|清算|注销|吊销/.test(type) ? 60 : 50;
  const highRiskCompanyMap = new Map();
  personHighRisks.forEach((risk) => {
    (risk.examples || []).forEach((example) => {
      if (!example.companyName || example.companyName === base.name) return;
      const key = String(example.companyId || example.companyName);
      const current = highRiskCompanyMap.get(key) || {
        name: example.companyName,
        companyId: example.companyId,
        riskTypes: new Set(),
        riskCount: 0,
        riskPriority: 0
      };
      current.riskTypes.add(risk.riskType || example.riskDesc || '高风险信号');
      current.riskCount += Number(example.riskCount || 0);
      current.riskPriority = Math.max(current.riskPriority, relatedRiskPriority(risk.riskType || example.riskDesc || ''));
      highRiskCompanyMap.set(key, current);
    });
  });
  const highRiskRelatedCompanies = [...highRiskCompanyMap.values()].map((item) => ({
    name: item.name,
    companyId: item.companyId,
    riskTypes: [...item.riskTypes],
    riskCount: item.riskCount,
    riskPriority: item.riskPriority
  })).sort((a, b) => b.riskPriority - a.riskPriority || b.riskCount - a.riskCount);
  const denseClosedNetwork = legalTotal > 30 && closedLegalCompanies.length >= 20;
  const legalLevel = denseClosedNetwork ? 'high' : highRiskRelatedCompanies.length ? 'medium' : 'low';
  const relatedCompanies = legalCompanies.slice(0, 30).map((item) => {
    const matchedRisk = highRiskRelatedCompanies.find((riskCompany) => riskCompany.name === item.name || (riskCompany.companyId && String(riskCompany.companyId) === String(item.id || item.companyId)));
    return {
      name: item.name || '关联企业',
      status: item.regStatus || item.status || '状态未披露',
      role: item.type || item.position || '关联角色未披露',
      riskLevel: matchedRisk ? 'high' : 'normal',
      riskSummary: matchedRisk ? `${matchedRisk.riskTypes.join('、')} · ${matchedRisk.riskCount} 条` : '',
      riskPriority: matchedRisk?.riskPriority || 0,
      url: item.id || item.companyId
        ? `https://www.tianyancha.com/company/${item.id || item.companyId}`
        : `https://www.tianyancha.com/search?key=${encodeURIComponent(item.name || '')}`
    };
  });
  highRiskRelatedCompanies.forEach((item) => {
    if (relatedCompanies.some((company) => company.name === item.name)) return;
    relatedCompanies.unshift({
      name: item.name,
      status: '周边高风险',
      role: '法人关联企业',
      riskLevel: 'high',
      riskSummary: `${item.riskTypes.join('、')} · ${item.riskCount} 条`,
      riskPriority: item.riskPriority,
      url: item.companyId ? `https://www.tianyancha.com/company/${item.companyId}` : `https://www.tianyancha.com/search?key=${encodeURIComponent(item.name)}`
    });
  });
  relatedCompanies.sort((a, b) => Number(b.riskLevel === 'high') - Number(a.riskLevel === 'high') || b.riskPriority - a.riskPriority);
  const legalReason = denseClosedNetwork
    ? `法人关联 ${legalTotal} 家企业且至少 ${closedLegalCompanies.length} 家已注销、吊销、撤销或清算，达到高风险红线。`
    : highRiskRelatedCompanies.length
      ? `法人关联企业中有 ${highRiskRelatedCompanies.length} 家出现周边高风险信号，整体判定为中风险；高风险企业已红色标出，可点击逐家核验。`
      : `法人关联 ${legalTotal} 家企业，其中 ${closedLegalCompanies.length} 家已注销、吊销、撤销或清算，未触发本规则风险阈值。`;

  const debtorCount = Math.max(countOf(data.debtor), overviewCount('被执行人'));
  const dishonestCount = Math.max(countOf(data.dishonest), overviewCount('失信被执行人'));
  const highConsumptionCount = Math.max(countOf(data.highConsumption), overviewCount('限制消费令', '限制高消费'));
  const equityFreezeCount = Math.max(countOf(data.equityFreeze), overviewCount('股权冻结'));
  const executionHigh = dishonestCount > 0 || highConsumptionCount > 0 || debtorCount >= 3 || equityFreezeCount > 0;
  const executionSummary = `被执行 ${debtorCount} · 失信 ${dishonestCount} · 限高 ${highConsumptionCount} · 股权冻结 ${equityFreezeCount}`;

  const seriousCount = Math.max(countOf(data.seriousViolation), overviewCount('严重违法', '严重违法失信'));
  const bankruptcyCount = Math.max(countOf(data.bankruptcy), overviewCount('破产重整'));
  const cancellationCount = Math.max(countOf(data.cancellation), overviewCount('注销备案'));
  const inactiveStatus = /注销|吊销|撤销|清算/.test(base.regStatus || '');
  const continuityHigh = seriousCount > 0 || bankruptcyCount > 0 || cancellationCount > 0 || inactiveStatus;

  const address = base.regLocation || reports[0]?.postalAddress || '未披露';
  const addressChanges = (data.changes?.items || []).filter((item) => /地址|住所|经营场所|驻在地址/.test(item.changeItem || ''));
  const highAddress = /(集中注册|集群注册|虚拟地址|工位|席位|卡位|挂靠|托管地址|商务秘书)/i.test(address);
  const smallOfficeAddress = /(住宅|公寓|单间|单元|室\d*号|\d+室|\d+层|小办公室|产业园.*[A-Z]\d+号)/i.test(address);
  const addressLevel = highAddress ? 'high' : smallOfficeAddress ? 'notice' : 'low';
  const addressReason = highAddress
    ? '登记地址明确出现集中注册、虚拟地址、工位、挂靠或托管特征，判定为高风险。'
    : smallOfficeAddress
      ? '地址呈现住宅、公寓、单间、房号或小办公室特征；该信号不触发风险判定，仅提示核验门牌、人员和实际办公条件。'
      : '地址文本未命中本规则的集中注册、虚拟地址、工位或挂靠特征。';

  const historyNames = [...new Set([...(base.historyNameList || []), ...((data.historyNames?.items || []).map((item) => item.name || item.historyName).filter(Boolean))])];
  const nameChangeRows = (data.changes?.items || []).filter((item) => /名称/.test(item.changeItem || ''));
  const nameChangeCount = Math.max(historyNames.length, nameChangeRows.length);
  const age = yearsSince(base.estiblishTime);
  const ageLevel = age !== null && age < 1 ? 'medium' : age === null ? 'notice' : 'low';
  const staff = Number(base.socialStaffNum);
  const staffKnown = Number.isFinite(staff);
  const staffLevel = !staffKnown || staff === 0 ? 'notice' : 'low';

  const hearingTotal = Math.max(countOf(data.hearings), overviewCount('开庭公告'));
  const judicialDocCount = Math.max(countOf(data.judicialDocs), overviewCount('裁判文书'));
  const adminCount = Math.max(countOf(data.adminPenalty), overviewCount('行政处罚'));
  const exceptionCount = Math.max(countOf(data.businessException), overviewCount('经营异常'));
  const taxCount = Math.max(countOf(data.taxArrears), overviewCount('欠税公告'));

  const rules = [
    makeRule('suspicious-relations', '电话、邮箱等疑似关系', relationLevel, suspiciousCount ? `${suspiciousCount} 条疑似关系` : '未录入疑似关系', relationReason,
      relationTypes.map((item) => ({ label: item.type || '疑似关系', value: `${item.count ?? relationTotal} 条 · ${item.note || suspiciousRelations.source || '人工复核数据'}` })), { priority: 100 }),
    makeRule('legal-network', '法人关联企业风险', legalLevel, `关联 ${legalTotal} 家 · 注销等 ${closedLegalCompanies.length} 家 · 高风险关联公司 ${highRiskRelatedCompanies.length} 家`, legalReason,
      [
        ...legalCompanies.slice(0, 8).map((item) => ({ label: item.regStatus || item.status || '状态未披露', value: `${item.name} · ${item.type || item.position || '关联角色未披露'}` })),
        ...personHighRisks.slice(0, 5).map((item) => ({ label: item.riskType || '法人周边高风险', value: `${item.count || 0} 条 · ${item.riskLevel}` }))
      ], { priority: 90, relatedCompanies }),
    makeRule('execution', '执行、失信、限高与股权冻结', executionHigh ? 'high' : 'low', executionSummary,
      executionHigh ? '命中失信、限高、被执行不少于 3 条或股权冻结中的至少一项，判定为高风险。' : '已核验执行、失信、限高与股权冻结，未命中高风险阈值。',
      [
        ...evidenceFrom(data.debtor, ['caseCode','caseNo'], ['execMoney','execCourtName','caseCreateTime'], '被执行记录'),
        ...evidenceFrom(data.dishonest, ['caseCode','caseNo'], ['businessentity','performance','publishDate'], '失信记录'),
        ...evidenceFrom(data.highConsumption, ['caseCode','caseNo'], ['xname','applicant','publishDate'], '限高记录'),
        ...evidenceFrom(data.equityFreeze, ['executeNoticeNum','caseNo'], ['executiveCourt','equityAmount','publicityDate'], '股权冻结')
      ], { priority: 80 }),
    makeRule('continuity', '严重违法与主体存续', continuityHigh ? 'high' : 'low', `严重违法 ${seriousCount} · 破产重整 ${bankruptcyCount} · 注销备案 ${cancellationCount} · 当前${base.regStatus || '状态未披露'}`,
      continuityHigh ? '命中严重违法失信、破产重整或注销/吊销/撤销/清算信号，判定为高风险。' : '已核验严重违法、破产重整和主体状态，未发现高风险信号。',
      [
        ...evidenceFrom(data.seriousViolation, ['putDate','inDate'], ['putReason','removeReason','decisionOffice'], '严重违法失信'),
        ...evidenceFrom(data.bankruptcy, ['caseNo','caseCode'], ['caseType','court','publishDate'], '破产重整'),
        ...evidenceFrom(data.cancellation, ['cancelDate','publishDate'], ['cancelReason','cancelAuthority'], '注销备案')
      ], { priority: 75 }),
    makeRule('address', '注册地址与办公场所', addressLevel, address, addressReason,
      [{ label: '当前登记地址', value: address }, ...addressChanges.slice(0, 5).map((item) => ({ label: item.changeTime || '地址变更', value: `${item.contentBefore || ''} → ${item.contentAfter || ''}` }))], { priority: 70 }),
    makeRule('history', '历史名称', nameChangeCount > 0 ? 'notice' : 'low', `${nameChangeCount} 个历史名称/改名信号`,
      nameChangeCount > 0 ? '历史名称仅作为主体连续性核验提醒，不触发高、中风险，也不改变总体风险等级。' : '未发现历史名称；本项不触发风险判定。',
      [...historyNames.slice(0, 8).map((item, index) => ({ label: `曾用名 ${index + 1}`, value: item })), ...nameChangeRows.slice(0, 5).map((item) => ({ label: item.changeTime || '名称变更', value: `${item.contentBefore || ''} → ${item.contentAfter || ''}` }))], { priority: 65 }),
    makeRule('age', '主体年限', ageLevel, age === null ? '成立时间未披露' : `成立 ${age.toFixed(1)} 年`,
      age !== null && age < 1 ? '成立不足 1 年，经营和履约记录尚短，判定为中风险。' : age === null ? '成立日期未披露，仅提示人工核验，不直接触发风险。' : '成立已满 1 年，本项不触发风险判定。',
      [{ label: '成立日期', value: base.estiblishTime || '未披露' }, { label: '经营状态', value: base.regStatus || '未披露' }], { priority: 50 }),
    makeRule('staff', '社保与人员', staffLevel, staffKnown ? `参保 ${staff} 人` : '参保人数未披露',
      staffKnown && staff === 0 ? '参保人数为 0，仅作为经营真实性核验提示，不触发风险判定。' : !staffKnown ? '参保人数未披露，仅提示人工核验，不触发风险判定。' : '参保人数大于 0，本项不触发风险判定。',
      [{ label: '参保人数', value: staffKnown ? `${staff} 人` : '未披露' }, { label: '人员规模', value: base.staffNumRange || '未披露' }], { priority: 45 }),
    makeRule('other-records', '开庭、裁判与行政经营记录', 'low', `开庭 ${hearingTotal} · 裁判 ${judicialDocCount} · 行政处罚 ${adminCount} · 经营异常 ${exceptionCount} · 欠税 ${taxCount}`,
      '这些记录保留为尽调证据，不单独改变本版高/中/低风险等级；请结合案由、身份、金额、是否移出及合作场景人工判断。',
      [
        ...hearingItems.slice(0, 5).map((item) => ({ label: item.startDate || '开庭日期未披露', value: [item.caseReason, item.court, item.caseNo].filter(Boolean).join(' · ') })),
        ...evidenceFrom(data.judicialDocs, ['caseNo','title'], ['caseReason','judgeTime','judgmentResult'], '裁判文书'),
        ...evidenceFrom(data.adminPenalty, ['punishNumber','decisionNumber'], ['reason','content','decisionDate'], '行政处罚'),
        ...evidenceFrom(data.businessException, ['putDate','inDate'], ['putReason','removeReason','decisionOffice'], '经营异常'),
        ...evidenceFrom(data.taxArrears, ['taxType','taxCategory'], ['balance','location','publishDate'], '欠税公告')
      ], { priority: 20 })
  ];

  const severity = { high: 4, medium: 3, notice: 2, low: 1 };
  rules.sort((a, b) => severity[b.level] - severity[a.level] || b.priority - a.priority);
  const overallLevel = rules.some((item) => item.level === 'high') ? 'high' : rules.some((item) => item.level === 'medium') ? 'medium' : 'low';
  const overallLabel = overallLevel === 'high' ? '高风险' : overallLevel === 'medium' ? '中风险' : '低风险';
  const triggerRules = rules.filter((item) => item.level === 'high' || item.level === 'medium').map((item) => `${item.title}：${item.levelLabel}`);
  const clearChecks = [];
  if (isAvailable(data.dishonest) && dishonestCount === 0) clearChecks.push('失信被执行人');
  if (isAvailable(data.seriousViolation) && seriousCount === 0) clearChecks.push('严重违法失信');
  if (isAvailable(data.highConsumption) && highConsumptionCount === 0) clearChecks.push('限制高消费');
  if (isAvailable(data.bankruptcy) && bankruptcyCount === 0) clearChecks.push('破产重整');
  if (!inactiveStatus && isAvailable(data.cancellation) && cancellationCount === 0) clearChecks.push('注销/吊销/撤销/清算');
  if (!highAddress) clearChecks.push('集中注册、虚拟地址、工位或挂靠地址');
  if (isAvailable(data.debtor) && debtorCount < 3) clearChecks.push('被执行不少于 3 条');
  if (isAvailable(data.equityFreeze) && equityFreezeCount === 0) clearChecks.push('股权冻结');
  if (isAvailable(data.personCompanies) && !denseClosedNetwork) clearChecks.push('法人关联超过 30 家且至少 20 家注销等');

  const describeTrigger = (item) => {
    if (item.id === 'suspicious-relations') return `发现电话、邮箱等疑似关系 ${suspiciousCount} 条，${suspiciousCount >= 20 ? '已超过 20 条高风险阈值，存在联系方式集中复用、挂靠或主体网络异常的可能' : '尚未达到高风险阈值，但仍需核实联系方式复用原因'}`;
    if (item.id === 'legal-network') {
      if (denseClosedNetwork) return `法人关联超过 30 家企业，且至少 ${closedLegalCompanies.length} 家已注销、吊销、撤销或清算，形成异常企业网络`;
      const names = highRiskRelatedCompanies.slice(0, 3).map((company) => company.name).join('、');
      return `法定代表人关联的${names || `${highRiskRelatedCompanies.length} 家企业`}存在失信、限高、被执行或其它周边高风险信号`;
    }
    if (item.id === 'execution') return `发现被执行 ${debtorCount} 条、失信 ${dishonestCount} 条、限制高消费 ${highConsumptionCount} 条、股权冻结 ${equityFreezeCount} 条，命中司法执行红线`;
    if (item.id === 'continuity') return `发现严重违法 ${seriousCount} 条、破产重整 ${bankruptcyCount} 条、注销备案 ${cancellationCount} 条，当前经营状态为${base.regStatus || '未披露'}`;
    if (item.id === 'address') return '注册地址明确出现集中注册、虚拟地址、工位、挂靠或托管特征';
    if (item.id === 'age') return `公司成立仅 ${age?.toFixed(1) ?? '不足 1'} 年，经营和履约记录尚短`;
    return item.reason.replace(/[。；]+$/g, '');
  };
  const decisiveRules = rules.filter((item) => item.level === 'high' || item.level === 'medium');
  const explanationParts = [`该公司风险等级为${overallLabel}。`];
  if (decisiveRules.length) {
    explanationParts.push(`最主要原因是${describeTrigger(decisiveRules[0])}。`);
    decisiveRules.slice(1, 3).forEach((item) => explanationParts.push(`此外，${describeTrigger(item)}。`));
  } else {
    explanationParts.push('当前可查询项目未命中高风险或中风险阈值。');
  }
  const operatingSignals = [];
  if (age !== null && age >= 1) operatingSignals.push(`公司成立已有 ${age.toFixed(1)} 年`);
  if (staffKnown && staff > 0) operatingSignals.push(`参保人数为 ${staff} 人`);
  if (historyNames.length > 0 || nameChangeCount > 0) {
    const historySignal = `发现 ${nameChangeCount} 个历史名称或改名信号`;
    explanationParts.push(operatingSignals.length
      ? `虽然${historySignal}，但该项仅作为主体连续性核验提醒，不直接提高风险等级；同时，${operatingSignals.join('，')}，这些经营信号可作为稳定性参考。`
      : `${historySignal}，但该项仅作为主体连续性核验提醒，不直接提高风险等级。`);
  } else if (operatingSignals.length) {
    explanationParts.push(`${operatingSignals.join('，')}，上述经营信号可作为稳定性参考。`);
  }
  if (staffKnown && staff === 0) explanationParts.push('参保人数为 0，仅作为经营真实性核验提示，不单独提高风险等级。');
  if (smallOfficeAddress && !highAddress) explanationParts.push('注册地址呈现住宅、公寓、房号或小办公室特征，仅提示核验实际办公条件，不单独提高风险等级。');
  if (overallLevel === 'high') explanationParts.push('正常的成立年限、参保人数等经营信号不能抵消已经命中的高风险红线。');
  const riskExplanation = explanationParts.join('');

  return {
    company: {
      name: base.name,
      creditCode: base.creditCode,
      legalPerson: base.legalPersonName,
      status: base.regStatus,
      industry: base.industry,
      address,
      established: base.estiblishTime,
      tycUrl: exactCompany?.id ? `https://www.tianyancha.com/company/${exactCompany.id}` : `https://www.tianyancha.com/search?key=${encodeURIComponent(base.name || '')}`
    },
    riskLevel: overallLevel,
    riskLabel: overallLabel,
    verdict: overallLevel === 'high'
      ? '已命中至少一项高风险红线，建议暂停自动准入并转人工合规复核。'
      : overallLevel === 'medium'
        ? '未命中高风险红线，但存在中风险信号，建议补充材料后再决定合作额度。'
        : '当前可查询项目未命中高、中风险阈值，可按常规流程继续尽调。',
    riskExplanation,
    triggers: triggerRules,
    clearChecks,
    rules,
    dataAvailability: {
      available: ['工商登记与历史变更','法人关联企业与人员风险','被执行/失信/限高','股权冻结','开庭公告/裁判文书','行政处罚/经营异常/严重违法','欠税公告','破产重整/注销吊销'],
      derived: ['法人关联数量与注销数量','历史名称数量','地址文本特征','主体年限'],
      unavailable: ['未人工补录的电话/邮箱反向关联','同一注册地址企业总数','设备登录关系','收款账户关系','封禁后设备或客服号复用']
    },
    meta: {
      mode: 'live',
      queriedAt: new Date().toISOString(),
      ruleVersion: '3.0.1-levels',
      note: '本结果用于合作准入初筛，不构成征信、法律或投资结论；“未发现”仅表示当前接口和已补录数据未返回相关记录。'
    }
  };
}


module.exports = { classifyCompanyRisk };
