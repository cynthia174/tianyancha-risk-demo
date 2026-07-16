const { runTyc, runOptionalTyc } = require('./tyc-client');
const { classifyCompanyRisk } = require('./risk-engine');

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


module.exports = { queryCompany, searchCompanies };
