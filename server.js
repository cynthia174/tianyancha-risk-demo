const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MANUAL_RISK_PATH = path.join(__dirname, 'data', 'manual-risk-overrides.json');
const MANUAL_RISK_OVERRIDES = (() => {
  try {
    return JSON.parse(fs.readFileSync(MANUAL_RISK_PATH, 'utf8'));
  } catch {
    return {};
  }
})();
const TYC_ENTRY = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'tyc-cli', 'dist', 'index.js')
  : null;

function runTyc(args) {
  return new Promise((resolve, reject) => {
    const command = TYC_ENTRY ? process.execPath : 'tyc';
    const commandArgs = TYC_ENTRY ? [TYC_ENTRY, ...args] : args;
    execFile(command, commandArgs, {
      cwd: __dirname,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 6 * 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || '天眼查 CLI 调用失败').trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error('天眼查返回了无法解析的数据'));
      }
    });
  });
}

function runOptionalTyc(args) {
  return runTyc(args).catch((error) => ({
    _error: error.message,
    _empty: true,
    items: [],
    total: 0
  }));
}

function numberFromCapital(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/,/g, '');
  const match = text.match(/[\d.]+/);
  if (!match) return null;
  let amount = Number(match[0]);
  if (!Number.isFinite(amount)) return null;
  if (/亿/.test(text)) amount *= 10000;
  return amount;
}

function yearsSince(dateText) {
  const timestamp = Date.parse(dateText);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (Date.now() - timestamp) / 31557600000);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function riskStatus(score, weight) {
  const ratio = score / weight;
  if (ratio >= 0.78) return 'good';
  if (ratio >= 0.48) return 'watch';
  return 'risk';
}

function rule(id, title, weight, score, summary, reason, evidence) {
  const safeScore = clamp(Math.round(score), 0, weight);
  return {
    id,
    title,
    weight,
    score: safeScore,
    status: riskStatus(safeScore, weight),
    summary,
    reason,
    evidence: Array.isArray(evidence) ? evidence : []
  };
}

function scoreCompany(registration, annualReports, hearings, overview, searchResult) {
  const base = registration?.sources?.base || registration?.base || {};
  const reports = annualReports?.items || [];
  const hearingItems = hearings?.items || [];
  const riskItems = overview?.toolRisks || [];
  const relationRisks = overview?.relationRiskNotes || [];
  const detailRisks = overview?.detailRisks || [];
  const exactCompany = (searchResult?.items || []).find((item) =>
    item.name === base.name && (!base.creditCode || item.creditCode === base.creditCode)
  );
  const age = yearsSince(base.estiblishTime);
  const ageLabel = age === null ? '未披露' : `${age.toFixed(1)} 年`;

  let ageScore = 7;
  let ageReason = '成立时间未完整披露，暂按中性分处理。';
  if (age !== null) {
    if (age < 1) {
      ageScore = 1;
      ageReason = '成立不足 1 年，经营周期和履约记录尚未得到验证，不建议常规合作。';
    } else if (age < 3) {
      ageScore = 4;
      ageReason = '成立未满 3 年，按规则不建议直接进入常规合作，应先小额试单并人工尽调。';
    } else if (age < 5) {
      ageScore = 10;
      ageReason = '成立 3–5 年，已有一定经营周期，但仍需结合年报连续性验证。';
    } else {
      ageScore = 15;
      ageReason = '成立超过 5 年，且有多个年度经营记录，存续基础较稳定。';
    }
  }

  const registered = numberFromCapital(base.regCapital);
  const paid = numberFromCapital(base.actualCapital);
  const paidRatio = registered && paid !== null ? paid / registered : null;
  let capitalScore = 8;
  let capitalReason = '实缴或注册资本数据不完整，无法计算实缴比例，建议索取验资或财务材料。';
  if (paidRatio !== null) {
    if (paid <= 0) {
      capitalScore = 1;
      capitalReason = '实缴资本为 0 或未形成实缴，资金承诺兑现度低。';
    } else if (paidRatio < 0.1) {
      capitalScore = 4;
      capitalReason = '实缴资本不足注册资本的 10%，与大额合作的资金承载能力可能不匹配。';
    } else if (paidRatio < 0.3) {
      capitalScore = 7;
      capitalReason = '实缴比例低于 30%，需要结合合同金额、资产和现金流进一步核验。';
    } else if (paidRatio < 0.5) {
      capitalScore = 10;
      capitalReason = '实缴比例处于 30%–50%，资金兑现度中等。';
    } else if (paidRatio < 0.8) {
      capitalScore = 13;
      capitalReason = '实缴比例超过 50%，资本兑现度较好。';
    } else {
      capitalScore = 15;
      capitalReason = '实缴资本接近或达到注册资本，资本兑现度较高。';
    }
  }

  const staff = Number(base.socialStaffNum);
  const staffKnown = Number.isFinite(staff);
  let staffScore = 9;
  let staffReason = '社保人数未披露，不能据此推定无人经营，需结合招聘和现场信息复核。';
  if (staffKnown) {
    if (staff === 0) {
      staffScore = 2;
      staffReason = '当前参保人数为 0，是较强的经营真实性风险信号。';
    } else if (staff < 5) {
      staffScore = 5;
      staffReason = '参保人数低于 5 人，承接持续交付或大额项目的能力需要重点核验。';
    } else if (staff < 20) {
      staffScore = 10;
      staffReason = '参保人数较少，适合轻资产小团队，但与大额合作匹配度一般。';
    } else if (staff < 50) {
      staffScore = 14;
      staffReason = '参保人数达到小型企业常见规模，具备一定履约基础。';
    } else if (staff < 200) {
      staffScore = 17;
      staffReason = '参保人数较充足，人员稳定性信号较好。';
    } else {
      staffScore = 20;
      staffReason = '参保人数规模较大，人员与组织承载能力信号良好。';
    }
  }

  const address = base.regLocation || reports[0]?.postalAddress || '未披露';
  const addressHistory = [...new Set(reports.map((item) => item.postalAddress).filter(Boolean))];
  const highRiskAddress = /(商务秘书|集中办公|集群注册|托管地址|虚拟地址|众创空间)/.test(address);
  const roomLike = /(室|号楼|单元|住宅|公寓)/.test(address);
  const operatingLike = /(工业园|产业园|厂|基地|镇|路\d+号|大道\d+号)/.test(address.replace(/\s/g, ''));
  let addressScore = 11;
  let addressReason = '登记地址可定位，但仅凭工商地址无法判断办公室面积，建议叠加同址企业密度与现场核验。';
  if (highRiskAddress) {
    addressScore = 4;
    addressReason = '地址含集中注册、商务秘书或虚拟办公特征，存在挂靠地址风险。';
  } else if (roomLike && !operatingLike) {
    addressScore = 8;
    addressReason = '地址呈现住宅/房间号特征，可能是小型办公室，需要核验门牌、人员和设备。';
  } else if (operatingLike) {
    addressScore = 14;
    addressReason = '地址呈现产业园、道路门牌或生产经营场所特征，经营场所信号较好。';
  }
  if (addressHistory.length >= 4) {
    addressScore -= 3;
    addressReason += ' 历史通信地址变化较多，需确认当前实际办公地点。';
  }

  const hearingRisk = riskItems.find((item) => item.riskType === '开庭公告');
  const hearingTotal = Number(hearings?.total ?? hearingRisk?.count ?? hearingItems.length) || 0;
  const defendantCount = hearingItems.filter((item) =>
    Array.isArray(item.defendant) && item.defendant.some((party) => party.name === base.name)
  ).length;
  const plaintiffCount = hearingItems.filter((item) =>
    Array.isArray(item.plaintiff) && item.plaintiff.some((party) => party.name === base.name)
  ).length;
  let hearingScore = 20;
  let hearingReason = '当前查询范围未发现开庭公告。';
  if (hearingTotal > 0) {
    if (hearingTotal <= 2) hearingScore = 17;
    else if (hearingTotal <= 10) hearingScore = 14;
    else if (hearingTotal <= 30) hearingScore = 10;
    else if (hearingTotal <= 100) hearingScore = 6;
    else hearingScore = 3;
    if (plaintiffCount > defendantCount) hearingScore += 3;
    if (defendantCount >= Math.max(2, plaintiffCount * 1.5)) hearingScore -= 2;
    hearingReason = `共有 ${hearingTotal} 条开庭公告；本次明细中作为被告 ${defendantCount} 条、作为原告 ${plaintiffCount} 条。公告不等于败诉，但数量和角色结构会影响合作风险。`;
  }

  const severeTypes = new Set(['失信被执行人', '限制消费令', '被执行人', '严重违法', '经营异常']);
  const directSevere = riskItems.filter((item) => severeTypes.has(item.riskType));
  const directWarnings = riskItems.filter((item) => item.riskType !== '开庭公告');
  let networkScore = 15 - directSevere.length * 4 - Math.min(5, directWarnings.length);
  networkScore = clamp(networkScore, 1, 15);
  const networkReason = directSevere.length
    ? `命中 ${directSevere.length} 类重点风险，需要核验是否仍在持续及是否已履行完毕。`
    : `未命中直接失信/限高类重点风险；另有 ${relationRisks.length} 条关联网络风险，仅作弱风险提示。`;

  const rules = [
    rule('age', '成立年限', 15, ageScore, `成立 ${ageLabel}`, ageReason, [
      { label: '成立日期', value: base.estiblishTime || '未披露' },
      { label: '经营状态', value: base.regStatus || '未披露' },
      { label: '年报记录', value: `${reports.length} 个年度` }
    ]),
    rule('capital', '注册与实缴资本', 15, capitalScore,
      paidRatio === null ? '实缴比例未披露' : `实缴比例 ${(paidRatio * 100).toFixed(1)}%`,
      capitalReason,
      [
        { label: '注册资本', value: base.regCapital || '未披露' },
        { label: '实缴资本', value: base.actualCapital || '未披露' },
        { label: '数据日期', value: base.approvedTime || base.updateTimes || '未披露' }
      ]
    ),
    rule('staff', '社保与人员规模', 20, staffScore,
      staffKnown ? `参保 ${staff} 人` : '参保人数未披露',
      staffReason,
      [
        { label: '参保人数', value: staffKnown ? `${staff} 人` : '未披露' },
        { label: '人员规模', value: base.staffNumRange || '未披露' },
        ...reports.slice(0, 4).map((item) => ({ label: `${item.reportYear} 年报`, value: item.employeeCount || '未披露' }))
      ]
    ),
    rule('address', '地址与经营场所', 15, addressScore, address, addressReason,
      [{ label: '当前登记地址', value: address }, ...addressHistory.slice(0, 5).map((item, index) => ({ label: `历史地址 ${index + 1}`, value: item }))]
    ),
    rule('hearing', '开庭公告', 20, hearingScore, `${hearingTotal} 条开庭公告`, hearingReason,
      hearingItems.slice(0, 10).map((item) => ({
        label: item.startDate || '日期未披露',
        value: [item.caseReason, item.court, item.caseNo].filter(Boolean).join(' · ') || '开庭信息'
      }))
    ),
    rule('network', '经营合规与关联风险', 15, networkScore,
      `${directWarnings.length} 类直接风险 / ${relationRisks.length} 条关联提示`, networkReason,
      [
        ...detailRisks.slice(0, 4).map((item) => ({ label: item.level || '提示', value: item.title })),
        ...directWarnings.slice(0, 5).map((item) => ({ label: item.riskType, value: `${item.count} 条 · ${item.riskLevel}` }))
      ]
    )
  ];

  let totalScore = rules.reduce((sum, item) => sum + item.score, 0);
  const hardFlags = [];
  if (age !== null && age < 3) hardFlags.push('成立未满 3 年');
  if (paidRatio !== null && paidRatio < 0.1) hardFlags.push('实缴比例低于 10%');
  if (staffKnown && staff === 0) hardFlags.push('参保人数为 0');
  if (highRiskAddress) hardFlags.push('疑似集中/挂靠注册地址');
  if (directSevere.length) {
    hardFlags.push('命中执行/失信/异常类风险');
    totalScore = Math.min(totalScore, 49);
  }
  if (age !== null && age < 3 && paidRatio !== null && paidRatio < 0.1) {
    totalScore = Math.min(totalScore, 59);
  }

  let grade = 'D';
  let verdict = '高风险，建议暂缓合作并由法务或合规复核。';
  if (totalScore >= 85) {
    grade = 'A';
    verdict = '低风险，可进入常规准入流程。';
  } else if (totalScore >= 70) {
    grade = 'B';
    verdict = '可合作，建议采用分阶段交付与额度控制。';
  } else if (totalScore >= 50) {
    grade = 'C';
    verdict = '需要关注，建议人工尽调并先小额试单。';
  }

  return {
    company: {
      name: base.name,
      creditCode: base.creditCode,
      legalPerson: base.legalPersonName,
      status: base.regStatus,
      industry: base.industry,
      address,
      established: base.estiblishTime,
      tycUrl: exactCompany?.id
        ? `https://www.tianyancha.com/company/${exactCompany.id}`
        : `https://www.tianyancha.com/search?key=${encodeURIComponent(base.name || '')}`
    },
    score: totalScore,
    grade,
    verdict,
    hardFlags,
    rules,
    meta: {
      mode: 'live',
      queriedAt: new Date().toISOString(),
      note: '开庭公告代表程序信息，不等同于败诉；地址面积需结合地图、同址企业和现场证据复核。'
    }
  };
}

function scoreCompanyV2(registration, data) {
  const base = registration?.sources?.base || registration?.base || {};
  const reports = data.annual?.items || [];
  const hearingItems = data.hearings?.items || [];
  const riskItems = data.overview?.toolRisks || [];
  const relationRisks = data.overview?.relationRiskNotes || [];
  const exactCompany = (data.searchResult?.items || []).find((item) =>
    item.name === base.name && (!base.creditCode || item.creditCode === base.creditCode)
  );
  const countOf = (source) => Number(source?.total ?? source?.items?.length ?? 0) || 0;
  const overviewCount = (type) => Number(riskItems.find((item) => item.riskType === type)?.count || 0);
  const evidenceFrom = (source, labelKeys, valueKeys, fallback) => (source?.items || []).slice(0, 8).map((item, index) => {
    const getValue = (keys) => keys.map((key) => item[key]).find((value) => value !== undefined && value !== null && value !== '');
    const format = (value) => {
      if (Array.isArray(value)) return value.map((entry) => entry?.name || entry).filter(Boolean).join('、');
      if (value && typeof value === 'object') return value.name || JSON.stringify(value);
      return String(value || '未披露');
    };
    const label = getValue(labelKeys);
    const values = valueKeys.map((key) => item[key]).filter((value) => value !== undefined && value !== null && value !== '').map(format);
    return { label: format(label || `${fallback} ${index + 1}`), value: values.join(' · ') || fallback };
  });

  const age = yearsSince(base.estiblishTime);
  let ageScore = 3;
  let ageReason = '成立日期未披露，按中性偏谨慎处理。';
  if (age !== null) {
    if (age < 1) {
      ageScore = 0;
      ageReason = '成立不足 1 年，属于重点关注阶段，经营周期和履约记录尚未充分验证。';
    } else if (age < 2) {
      ageScore = 1;
      ageReason = '成立 1–2 年，经营记录仍较短，需要关注并优先小额试单。';
    } else if (age < 3) {
      ageScore = 2;
      ageReason = '成立 2–3 年，已有初步经营记录，但本项得分仍不高。';
    } else if (age < 5) {
      ageScore = 4;
      ageReason = '成立 3–5 年，经营时间尚可，已有一定存续和履约验证。';
    } else {
      ageScore = 6;
      ageReason = '成立达到 5 年或以上，主体存续时间较长，本项表现很好。';
    }
  }
  if (/注销|吊销|撤销|清算/.test(base.regStatus || '')) ageScore = 0;

  const registered = numberFromCapital(base.regCapital);
  const paid = numberFromCapital(base.actualCapital);
  const paidRatio = registered && paid !== null ? paid / registered : null;
  let capitalScore = 2;
  let capitalReason = '实缴数据不完整，无法确认资本承诺兑现程度。';
  if (paidRatio !== null) {
    if (paid <= 0) {
      capitalScore = 0;
      capitalReason = '实缴资本为 0，资金承诺兑现度低。';
    } else if (paidRatio < 0.1) {
      capitalScore = 1;
      capitalReason = '实缴比例不足 10%，大额合作的资金承载能力需要重点核验。';
    } else if (paidRatio < 0.3) {
      capitalScore = 1;
      capitalReason = '实缴比例低于 30%，需补充资产和现金流材料。';
    } else if (paidRatio < 0.8) {
      capitalScore = 2;
      capitalReason = '实缴比例处于中等水平。';
    } else {
      capitalScore = 3;
      capitalReason = '实缴资本接近或达到注册资本，资本兑现度较高。';
    }
  }

  const staff = Number(base.socialStaffNum);
  const staffKnown = Number.isFinite(staff);
  let staffScore = 8;
  let staffReason = '社保人数未披露，不能据此推定无人经营，需人工复核。';
  if (staffKnown) {
    if (staff === 0) {
      staffScore = 5;
      staffReason = '参保人数为 0，按中风险处理；可能存在外包、劳务派遣或未披露情形，不能单独据此判定为空壳或高风险。';
    } else if (staff < 5) {
      staffScore = 4;
      staffReason = '参保人数低于 5 人，履约承载能力需要重点核验。';
    } else if (staff < 20) {
      staffScore = 9;
      staffReason = '参保人数较少，适合轻资产小团队，但与大额合作匹配度一般。';
    } else if (staff < 100) {
      staffScore = 14;
      staffReason = '人员规模达到一般小型企业常见水平。';
    } else {
      staffScore = 17;
      staffReason = '参保人数较充足，组织承载能力信号良好。';
    }
  }

  const address = base.regLocation || reports[0]?.postalAddress || '未披露';
  const addressHistory = [...new Set(reports.map((item) => item.postalAddress).filter(Boolean))];
  const addressChanges = (data.changes?.items || []).filter((item) => /地址|住所|经营场所|驻在地址/.test(item.changeItem || ''));
  const clusteredAddress = /(商务秘书|集中办公|集群注册|托管地址|虚拟地址|众创空间|工位|席位|卡位|[A-Z]{1,3}区\d+层[A-Z]\d+号)/i.test(address);
  const roomLike = /(室|号楼|单元|住宅|公寓|\d+层)/.test(address);
  const operatingLike = /(工业园|产业园|厂|基地|镇|路\d+号|大道\d+号)/.test(address.replace(/\s/g, ''));
  let addressScore = 10;
  let addressReason = '登记地址可定位，但当前接口不能直接反查同址企业总数，需要地址画像库二次计算。';
  if (clusteredAddress) {
    addressScore = 2;
    addressReason = '地址呈现集中注册、工位号或商务托管特征，挂靠风险较高；同址企业总数仍需地址画像库确认。';
  } else if (roomLike && !operatingLike) {
    addressScore = 6;
    addressReason = '地址呈现住宅或小办公室特征，需要核验门牌、人员和设备。';
  } else if (operatingLike) {
    addressScore = 16;
    addressReason = '地址呈现产业园、道路门牌或生产经营场所特征；尚未取得同址企业密度。';
  }
  if (addressChanges.length >= 3 || addressHistory.length >= 4) addressScore = Math.max(0, addressScore - 4);

  const legalCompanies = data.personCompanies?.items || [];
  const legalTotal = Number(data.personCompanies?.total ?? legalCompanies.length) || 0;
  const closedLegalCompanies = legalCompanies.filter((item) => /注销|吊销|撤销|清算/.test(item.regStatus || ''));
  const closedRatio = legalTotal ? closedLegalCompanies.length / legalTotal : 0;
  const personHighRisks = (data.personRisk?.riskGroups || []).flatMap((group) => group.risks || []).filter((item) => item.riskLevel === '高风险');
  const manualRisk = MANUAL_RISK_OVERRIDES[base.creditCode] || MANUAL_RISK_OVERRIDES[base.name] || {};
  const suspiciousRelations = data.suspiciousRelations || manualRisk.suspiciousRelations || {};
  const suspiciousRelationTotal = Number(suspiciousRelations.total || 0);
  const suspiciousRelationTypes = Array.isArray(suspiciousRelations.types) ? suspiciousRelations.types : [];
  const massContactReuse = suspiciousRelationTypes.some((item) =>
    /电话|邮箱/.test(item.type || '') && Number(item.count ?? suspiciousRelationTotal) >= 100
  );
  const suspiciousRelationSevere = massContactReuse || suspiciousRelationTotal >= 500 || (suspiciousRelationTotal >= 100 && suspiciousRelationTypes.length >= 2);
  let legalScore = data.personCompanies?._error ? 12 : 25;
  if (!data.personCompanies?._error) {
    if (legalTotal > 30) legalScore = 7;
    else if (legalTotal > 10) legalScore = 12;
    else if (legalTotal > 3) legalScore = 20;
    if (closedRatio >= 0.5) legalScore -= 6;
    if (closedLegalCompanies.length >= 20) legalScore = Math.min(legalScore, 2);
    legalScore -= Math.min(8, personHighRisks.length * 4);
    legalScore = clamp(legalScore, 0, 25);
  }
  if (suspiciousRelationTotal >= 1000) legalScore = 0;
  else if (suspiciousRelationSevere) legalScore = Math.min(legalScore, 2);
  else if (suspiciousRelationTotal >= 100) legalScore = Math.min(legalScore, 6);
  else if (suspiciousRelationTotal >= 20) legalScore = Math.min(legalScore, 12);
  const legalReason = data.personCompanies?._error
    ? '法人关联企业查询失败，本项未按安全处理，保留中性分等待复核。'
    : suspiciousRelationTotal
      ? `法人任职/股权关联 ${legalTotal} 家，但另发现 ${suspiciousRelationTotal} 条电话、邮箱等疑似关系，涉及 ${suspiciousRelationTypes.length} 类关联信号；疑似关系网络应独立按高风险处理。`
      : `法人关联 ${legalTotal} 家企业，其中 ${closedLegalCompanies.length} 家已注销/吊销/清算；另有 ${personHighRisks.length} 类法人周边高风险。`;

  const historyNames = [...new Set([...(base.historyNameList || []), ...((data.historyNames?.items || []).map((item) => item.name || item.historyName).filter(Boolean))])];
  const nameChangeRows = (data.changes?.items || []).filter((item) => /名称/.test(item.changeItem || ''));
  const nameChangeCount = Math.max(historyNames.length, nameChangeRows.length);
  const changeTotal = countOf(data.changes);
  let historyScore = 4;
  if (nameChangeCount >= 5) historyScore = 0;
  else if (nameChangeCount >= 3) historyScore = 1;
  else if (nameChangeCount === 2) historyScore = 2;
  else if (nameChangeCount === 1) historyScore = 3;
  if (changeTotal > 20) historyScore = Math.max(0, historyScore - 1);
  const historyReason = nameChangeCount
    ? `发现 ${nameChangeCount} 次/个历史名称信号，共 ${changeTotal} 条工商变更；频繁改名会增加主体连续性核验成本。`
    : `未发现曾用名，共 ${changeTotal} 条工商变更。`;

  const debtorCount = Math.max(countOf(data.debtor), overviewCount('被执行人'));
  const dishonestCount = Math.max(countOf(data.dishonest), overviewCount('失信被执行人'));
  const highConsumptionCount = Math.max(countOf(data.highConsumption), overviewCount('限制消费令'));
  let executionScore = 12;
  executionScore -= Math.min(8, debtorCount * 2);
  if (dishonestCount) executionScore = Math.min(executionScore, 1);
  if (highConsumptionCount) executionScore = Math.min(executionScore, 2);
  executionScore = clamp(executionScore, 0, 12);
  const executionReason = `被执行 ${debtorCount} 条、失信 ${dishonestCount} 条、限制高消费 ${highConsumptionCount} 条。失信或限高属于合作准入红线。`;

  const hearingTotal = Math.max(countOf(data.hearings), overviewCount('开庭公告'));
  const judicialDocCount = Math.max(countOf(data.judicialDocs), overviewCount('裁判文书'));
  const equityFreezeCount = Math.max(countOf(data.equityFreeze), overviewCount('股权冻结'));
  const defendantCount = hearingItems.filter((item) => Array.isArray(item.defendant) && item.defendant.some((party) => party.name === base.name)).length;
  const plaintiffCount = hearingItems.filter((item) => Array.isArray(item.plaintiff) && item.plaintiff.some((party) => party.name === base.name)).length;
  let judicialScore = 6;
  if (hearingTotal > 0) judicialScore -= hearingTotal <= 3 ? 1 : hearingTotal <= 20 ? 1 : hearingTotal <= 100 ? 2 : 3;
  if (defendantCount > plaintiffCount) judicialScore -= 1;
  if (judicialDocCount > 0) judicialScore -= Math.min(2, Math.ceil(judicialDocCount / 10));
  if (equityFreezeCount > 0) judicialScore -= Math.min(3, equityFreezeCount);
  judicialScore = clamp(judicialScore, 0, 6);
  const judicialReason = `开庭公告 ${hearingTotal} 条、裁判文书 ${judicialDocCount} 条、股权冻结 ${equityFreezeCount} 条；开庭公告不等于败诉。`;

  const adminCount = Math.max(countOf(data.adminPenalty), overviewCount('行政处罚'));
  const exceptionCount = Math.max(countOf(data.businessException), overviewCount('经营异常'));
  const seriousCount = Math.max(countOf(data.seriousViolation), overviewCount('严重违法'));
  const taxCount = Math.max(countOf(data.taxArrears), overviewCount('欠税公告'));
  let complianceScore = 5 - Math.min(2, adminCount) - Math.min(2, exceptionCount) - Math.min(2, taxCount);
  if (seriousCount) complianceScore = 0;
  complianceScore = clamp(complianceScore, 0, 5);
  const complianceReason = `行政处罚 ${adminCount} 条、经营异常 ${exceptionCount} 条、严重违法 ${seriousCount} 条、欠税公告 ${taxCount} 条。`;

  const bankruptcyCount = Math.max(countOf(data.bankruptcy), overviewCount('破产重整'));
  const cancellationCount = Math.max(countOf(data.cancellation), overviewCount('注销备案'));
  const inactiveStatus = /注销|吊销|撤销|清算/.test(base.regStatus || '');
  let continuityScore = 4;
  if (bankruptcyCount) continuityScore = Math.min(continuityScore, 1);
  if (cancellationCount) continuityScore = Math.min(continuityScore, 1);
  if (inactiveStatus) continuityScore = 0;
  const continuityReason = `当前状态：${base.regStatus || '未披露'}；破产重整 ${bankruptcyCount} 条、注销备案 ${cancellationCount} 条。`;

  const rules = [
    rule('age', '主体年限与状态', 6, ageScore, age === null ? '成立时间未披露' : `成立 ${age.toFixed(1)} 年`, ageReason, [
      { label: '成立日期', value: base.estiblishTime || '未披露' }, { label: '经营状态', value: base.regStatus || '未披露' }, { label: '年报记录', value: `${reports.length} 个年度` }
    ]),
    rule('capital', '注册与实缴资本', 3, capitalScore, paidRatio === null ? '实缴比例未披露' : `实缴比例 ${(paidRatio * 100).toFixed(1)}%`, capitalReason, [
      { label: '注册资本', value: base.regCapital || '未披露' }, { label: '实缴资本', value: base.actualCapital || '未披露' }
    ]),
    rule('staff', '社保与人员规模', 17, staffScore, staffKnown ? `参保 ${staff} 人` : '参保人数未披露', staffReason, [
      { label: '参保人数', value: staffKnown ? `${staff} 人` : '未披露' }, { label: '人员规模', value: base.staffNumRange || '未披露' }, ...reports.slice(0, 3).map((item) => ({ label: `${item.reportYear} 年报`, value: item.employeeCount || '未披露' }))
    ]),
    rule('address', '地址聚集与经营场所', 18, addressScore, address, addressReason, [
      { label: '当前登记地址', value: address }, { label: '同址企业数量', value: '当前天眼查 CLI 无反向地址聚合接口，需自建地址画像库' }, ...addressChanges.slice(0, 4).map((item) => ({ label: item.changeTime || '地址变更', value: `${item.contentBefore || ''} → ${item.contentAfter || ''}` }))
    ]),
    rule('legal-network', '法人与疑似关系网络', 25, legalScore, suspiciousRelationTotal ? `疑似关系 ${suspiciousRelationTotal} 条 · 法人关联 ${legalTotal} 家` : `法人关联 ${legalTotal} 家 / 注销等 ${closedLegalCompanies.length} 家`, legalReason, [
      ...suspiciousRelationTypes.map((item) => ({ label: item.type || '疑似关系', value: `${item.count ?? suspiciousRelationTotal} 条 · ${item.note || suspiciousRelations.source || '人工复核数据'}` })),
      ...legalCompanies.slice(0, 8).map((item) => ({ label: item.regStatus || '状态未披露', value: `${item.name} · ${item.type || '关联角色未披露'}` })),
      ...personHighRisks.slice(0, 3).map((item) => ({ label: item.riskType || '周边高风险', value: `${item.count || 0} 条 · ${item.riskLevel}` }))
    ]),
    rule('history', '历史名称与工商变更', 4, historyScore, `${nameChangeCount} 个改名信号 / ${changeTotal} 条变更`, historyReason, [
      ...historyNames.slice(0, 6).map((name, index) => ({ label: `曾用名 ${index + 1}`, value: name })),
      ...nameChangeRows.slice(0, 5).map((item) => ({ label: item.changeTime || '名称变更', value: `${item.contentBefore || ''} → ${item.contentAfter || ''}` }))
    ]),
    rule('execution', '执行、失信与限高', 12, executionScore, `被执行 ${debtorCount} / 失信 ${dishonestCount} / 限高 ${highConsumptionCount}`, executionReason, [
      ...evidenceFrom(data.debtor, ['caseCode','caseNo'], ['execMoney','execCourtName','caseCreateTime'], '被执行记录'),
      ...evidenceFrom(data.dishonest, ['caseCode','caseNo'], ['businessentity','performance','publishDate'], '失信记录'),
      ...evidenceFrom(data.highConsumption, ['caseCode','caseNo'], ['xname','applicant','publishDate'], '限高记录')
    ]),
    rule('judicial', '诉讼、裁判与股权冻结', 6, judicialScore, `开庭 ${hearingTotal} / 裁判 ${judicialDocCount} / 冻结 ${equityFreezeCount}`, judicialReason, [
      ...hearingItems.slice(0, 5).map((item) => ({ label: item.startDate || '开庭日期未披露', value: [item.caseReason, item.court, item.caseNo].filter(Boolean).join(' · ') })),
      ...evidenceFrom(data.judicialDocs, ['caseNo','title'], ['caseReason','judgeTime','judgmentResult'], '裁判文书'),
      ...evidenceFrom(data.equityFreeze, ['executeNoticeNum','caseNo'], ['executiveCourt','equityAmount','publicityDate'], '股权冻结')
    ]),
    rule('compliance', '行政、经营与税务风险', 5, complianceScore, `处罚 ${adminCount} / 异常 ${exceptionCount} / 严重违法 ${seriousCount} / 欠税 ${taxCount}`, complianceReason, [
      ...evidenceFrom(data.adminPenalty, ['punishNumber','decisionNumber'], ['reason','content','decisionDate'], '行政处罚'),
      ...evidenceFrom(data.businessException, ['putDate','inDate'], ['putReason','removeReason','decisionOffice'], '经营异常'),
      ...evidenceFrom(data.seriousViolation, ['putDate','inDate'], ['putReason','removeReason','decisionOffice'], '严重违法'),
      ...evidenceFrom(data.taxArrears, ['taxType','taxCategory'], ['balance','location','publishDate'], '欠税公告')
    ]),
    rule('continuity', '破产、注销与持续经营', 4, continuityScore, `${base.regStatus || '状态未披露'} / 破产 ${bankruptcyCount} / 注销备案 ${cancellationCount}`, continuityReason, [
      ...evidenceFrom(data.bankruptcy, ['caseNo','caseCode'], ['applicant','respondent','publishDate'], '破产重整'),
      ...evidenceFrom(data.cancellation, ['name','companyName'], ['regStatus','cancelDate','remark'], '注销备案')
    ])
  ];

  if (suspiciousRelationSevere) {
    const legalRule = rules.find((item) => item.id === 'legal-network');
    legalRule.severe = true;
    legalRule.severeLabel = '严重关联风险';
    legalRule.status = 'risk';
  }
  if (staffKnown && staff === 0) {
    const staffRule = rules.find((item) => item.id === 'staff');
    staffRule.status = 'watch';
  }
  if (clusteredAddress) {
    const addressRule = rules.find((item) => item.id === 'address');
    addressRule.severe = true;
    addressRule.severeLabel = '挂靠地址高风险';
    addressRule.status = 'risk';
  }

  const baseScore = rules.reduce((sum, item) => sum + item.score, 0);
  let totalScore = baseScore;
  const hardFlags = [];
  const severeRules = [];
  const capScore = (cap, label) => {
    severeRules.push({ type: 'cap', cap, label });
    totalScore = Math.min(totalScore, cap);
  };
  const deductScore = (points, label) => {
    severeRules.push({ type: 'deduction', points, label });
    totalScore = Math.max(0, totalScore - points);
  };
  if (age !== null && age < 1) hardFlags.push('成立不足 1 年：重点关注');
  else if (age !== null && age < 2) hardFlags.push('成立 1–2 年：需要关注');
  else if (age !== null && age < 3) hardFlags.push('成立 2–3 年：年限得分较低');
  if (paidRatio !== null && paidRatio < 0.1) hardFlags.push('实缴比例低于 10%');
  if (clusteredAddress) hardFlags.push('疑似集中/挂靠注册地址');
  if (clusteredAddress) capScore(59, '地址呈现集中注册、工位或挂靠特征：总分封顶 59 分');
  if (nameChangeCount >= 5) deductScore(8, '历史名称达到 5 个：总分额外扣 8 分');
  if (dishonestCount) capScore(39, '存在失信被执行记录：总分封顶 39 分');
  if (seriousCount) capScore(39, '存在严重违法失信记录：总分封顶 39 分');
  if (highConsumptionCount) capScore(49, '存在限制高消费记录：总分封顶 49 分');
  if (bankruptcyCount) capScore(49, '存在破产重整记录：总分封顶 49 分');
  if (inactiveStatus) capScore(49, `主体状态为${base.regStatus || '非正常'}：总分封顶 49 分`);
  if (debtorCount >= 3) capScore(59, '被执行记录达到 3 条：总分封顶 59 分');
  if (equityFreezeCount) capScore(59, '存在股权冻结记录：总分封顶 59 分');
  if (legalTotal > 30 && closedLegalCompanies.length >= 20) {
    hardFlags.push('法人关联企业异常密集且大量注销');
    capScore(59, '法人关联超过 30 家且至少 20 家注销等：总分封顶 59 分');
  }
  if (suspiciousRelationSevere) {
    capScore(49, `疑似关系网络达到 ${suspiciousRelationTotal} 条且类型密集：总分封顶 49 分`);
  }
  if (age !== null && age < 1 && staffKnown && staff === 0 && paidRatio !== null && paidRatio === 0) {
    capScore(39, '成立不足 1 年、零参保且零实缴同时命中：总分封顶 39 分');
  }
  hardFlags.push(...severeRules.map((item) => item.label));

  rules.forEach((item) => {
    item.priority = (item.severe ? 10000 : 0) + (item.weight - item.score) * 100 + item.weight;
  });
  rules.sort((a, b) => b.priority - a.priority);

  let grade = 'D';
  let verdict = '高风险，建议暂缓合作并由法务或合规复核。';
  if (totalScore >= 85) {
    grade = 'A';
    verdict = '低风险，可进入常规准入流程。';
  } else if (totalScore >= 70) {
    grade = 'B';
    verdict = '可合作，建议采用分阶段交付与额度控制。';
  } else if (totalScore >= 50) {
    grade = 'C';
    verdict = '需要关注，建议人工尽调并先小额试单。';
  }

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
    score: totalScore,
    baseScore,
    grade,
    verdict,
    hardFlags,
    severeRules,
    rules,
    dataAvailability: {
      available: ['工商登记与历史变更','法人关联企业与人员风险','人工复核的电话/邮箱疑似关系','被执行/失信/限高','股权冻结','开庭公告/裁判文书','行政处罚/经营异常/严重违法','欠税公告','破产重整/注销吊销'],
      derived: ['法人关联企业数量及注销比例','疑似关系数量与类型密度','历史名称变更频率','地址文本风险与地址变更频率'],
      unavailable: ['同一注册地址关联企业总数（需自建地址画像库）','未经人工录入的联系电话反向关联','设备登录企业账户','收款账户关联公司','封禁后复用设备/客服号']
    },
    meta: {
      mode: 'live',
      queriedAt: new Date().toISOString(),
      note: '“未发现记录”不等于绝对无风险；疑似关系可由人工复核数据补充，同址企业、设备和收款账户等仍需接入自有风控数据。'
    }
  };
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
  const denseClosedNetwork = legalTotal > 30 && closedLegalCompanies.length >= 20;
  const legalLevel = denseClosedNetwork ? 'high' : personHighRisks.length ? 'medium' : 'low';
  const relatedCompanies = legalCompanies.slice(0, 30).map((item) => ({
    name: item.name || '关联企业',
    status: item.regStatus || item.status || '状态未披露',
    role: item.type || item.position || '关联角色未披露',
    url: item.id || item.companyId
      ? `https://www.tianyancha.com/company/${item.id || item.companyId}`
      : `https://www.tianyancha.com/search?key=${encodeURIComponent(item.name || '')}`
  }));
  const legalReason = denseClosedNetwork
    ? `法人关联 ${legalTotal} 家企业且至少 ${closedLegalCompanies.length} 家已注销、吊销、撤销或清算，达到高风险红线。`
    : personHighRisks.length
      ? `法人关联企业中发现 ${personHighRisks.length} 类高风险指数信号，整体判定为中风险；可点击下方企业名称逐家核验。`
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
    makeRule('legal-network', '法人关联企业风险', legalLevel, `关联 ${legalTotal} 家 · 注销等 ${closedLegalCompanies.length} 家 · 周边高风险 ${personHighRisks.length} 类`, legalReason,
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
    makeRule('history', '历史名称', nameChangeCount >= 5 ? 'high' : 'low', `${nameChangeCount} 个历史名称/改名信号`,
      nameChangeCount >= 5 ? '历史名称达到 5 个，主体连续性核验成本高，判定为高风险。' : '历史名称未达到 5 个高风险阈值。',
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
  if ((isAvailable(data.historyNames) || isAvailable(data.changes)) && nameChangeCount < 5) clearChecks.push('历史名称达到 5 个');

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
      ruleVersion: '3.0-levels',
      note: '本结果用于合作准入初筛，不构成征信、法律或投资结论；“未发现”仅表示当前接口和已补录数据未返回相关记录。'
    }
  };
}

async function queryCompany(name) {
  const [registration, searchResult] = await Promise.all([
    runTyc(['company', 'registration-info', name, '--compact']),
    runTyc(['company', 'companies', name, '--compact'])
  ]);
  const base = registration?.sources?.base || registration?.base || {};
  const exactCompany = (searchResult?.items || []).find((item) => item.name === name);
  if (!base.name || !base.creditCode || !exactCompany || base.name !== exactCompany.name) {
    const error = new Error('未检索到企业，请重新输入');
    error.code = 'COMPANY_NOT_FOUND';
    throw error;
  }
  const legalPerson = base.legalPersonName || '';
  const personArgs = legalPerson ? ['--humanName', legalPerson] : [];
  const [annual, hearings, overview, historyNames, changes, debtor, dishonest, highConsumption, equityFreeze, judicialDocs, adminPenalty, businessException, seriousViolation, taxArrears, bankruptcy, cancellation] = await Promise.all([
    runOptionalTyc(['company', 'annual-reports', name, '--compact']),
    runOptionalTyc(['risk', 'hearing-notice', name, '--pageSize', '20', '--compact']),
    runOptionalTyc(['risk', 'overview', name, '--compact']),
    runOptionalTyc(['company', 'history-names', name, '--compact']),
    runOptionalTyc(['company', 'change-records', name, '--compact']),
    runOptionalTyc(['risk', 'judgment-debtor-info', name, '--compact']),
    runOptionalTyc(['risk', 'dishonest-info', name, '--compact']),
    runOptionalTyc(['risk', 'high-consumption-restriction', name, '--compact']),
    runOptionalTyc(['risk', 'equity-freeze', name, '--compact']),
    runOptionalTyc(['risk', 'judicial-documents', name, '--compact']),
    runOptionalTyc(['risk', 'administrative-penalty', name, '--compact']),
    runOptionalTyc(['risk', 'business-exception', name, '--compact']),
    runOptionalTyc(['risk', 'serious-violation', name, '--compact']),
    runOptionalTyc(['risk', 'tax-arrears-notice', name, '--compact']),
    runOptionalTyc(['risk', 'bankruptcy-reorganization', name, '--compact']),
    runOptionalTyc(['risk', 'cancellation-record-info', name, '--compact'])
  ]);
  const [personCompanies, personRisk] = legalPerson
    ? await Promise.all([
      runOptionalTyc(['executive', 'personnel-related-companies', name, ...personArgs, '--compact']),
      runOptionalTyc(['executive', 'person-risk-overview', name, ...personArgs, '--compact'])
    ])
    : [{ items: [], total: 0 }, { riskGroups: [], riskTotal: 0 }];
  return classifyCompanyRisk(registration, { annual, hearings, overview, searchResult, historyNames, changes, debtor, dishonest, highConsumption, equityFreeze, judicialDocs, adminPenalty, businessException, seriousViolation, taxArrears, bankruptcy, cancellation, personCompanies, personRisk });
}

async function searchCompanies(query) {
  const result = await runTyc(['company', 'companies', query, '--compact']);
  return (result?.items || []).slice(0, 10).map((item) => ({
    id: item.id,
    name: item.name,
    creditCode: item.creditCode || '',
    legalPerson: item.legalPersonName || '',
    status: item.regStatus || '状态未披露',
    established: (item.estiblishTime || item.establishTime || '').slice(0, 10),
    registeredCapital: item.regCapital || '',
    matchType: item.matchType || '',
    tycUrl: item.id
      ? `https://www.tianyancha.com/company/${item.id}`
      : `https://www.tianyancha.com/search?key=${encodeURIComponent(item.name || query)}`
  }));
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/company-search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (query.length < 2 || query.length > 50) {
      sendJson(res, 400, { error: '请输入至少 2 个字符的企业简称' });
      return;
    }
    try {
      sendJson(res, 200, { items: await searchCompanies(query) });
    } catch (error) {
      sendJson(res, 502, { error: '企业候选搜索失败，请稍后重试。', detail: error.message });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/company-risk') {
    const name = (url.searchParams.get('name') || '').trim();
    if (name.length < 2 || name.length > 100) {
      sendJson(res, 400, { error: '请输入完整企业名称（2–100 个字符）' });
      return;
    }
    try {
      sendJson(res, 200, await queryCompany(name));
    } catch (error) {
      if (error.code === 'COMPANY_NOT_FOUND') {
        sendJson(res, 404, { error: '未检索到企业，请重新输入' });
        return;
      }
      sendJson(res, 502, {
        error: '暂时无法取得该企业的数据，请确认企业全称后重试。',
        detail: error.message
      });
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`企业风险等级 Demo 已启动：http://127.0.0.1:${PORT}`);
});
