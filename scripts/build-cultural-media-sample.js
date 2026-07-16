const fs = require('fs');
const path = require('path');

const candidates = [
  { name: '合肥健康文化传媒有限公司', regCapital: '30万人民币' },
  { name: '合肥哔哟哔哟文化传媒有限公司', regCapital: '50万人民币' },
  { name: '合肥亮轩文化传媒有限公司', regCapital: '50万人民币' },
  { name: '合肥盛城文化传媒有限公司', regCapital: '10万人民币' },
  { name: '合肥晨领文化传媒有限公司', regCapital: '50万人民币' },
  { name: '合肥渠颂文化传媒有限公司', regCapital: '50万人民币' },
  { name: '西安半坡文化传媒有限公司', regCapital: '1万人民币' },
  { name: '西安风巷文化传媒有限公司', regCapital: '10.5263万人民币' },
  { name: '西安荣高文化传媒有限公司', regCapital: '11万人民币' },
  { name: '西安恒浩文化传媒有限公司', regCapital: '3万人民币' },
  { name: '西安守望麦田文化传媒有限公司', regCapital: '50万人民币' },
  { name: '西安汉家文化传媒有限公司', regCapital: '3万人民币' },
  { name: '西安盛腾文化传媒有限公司', regCapital: '58万人民币' },
  { name: '郑州秋杜文化传媒有限公司', regCapital: '10万人民币' },
  { name: '郑州曦航文化传媒有限公司', regCapital: '10万人民币' },
  { name: '郑州瞳耀文化传媒有限公司', regCapital: '50万人民币' },
  { name: '郑州旦果文化传媒有限公司', regCapital: '50万人民币' },
  { name: '郑州兆康文化传媒有限公司', regCapital: '50万人民币' },
  { name: '郑州至加文化传媒有限公司', regCapital: '10万人民币' },
  { name: '十五五十（成都）文化传媒有限公司', regCapital: '50万人民币' },
  { name: '成都伴星文化传媒有限公司', regCapital: '10万人民币' },
  { name: '成都勾勾互娱文化传媒有限公司', regCapital: '50万人民币' },
  { name: '成都乐翎华影文化传媒有限公司', regCapital: '50万人民币' },
  { name: '武汉思橙文化传媒有限公司', regCapital: '20万人民币' },
  { name: '武汉千星文化传媒有限公司', regCapital: '5万人民币' },
  { name: '武汉鼎驰景业文化传媒有限公司', regCapital: '50万人民币' },
  { name: '武汉一起追星文化传媒有限公司', regCapital: '10万人民币' },
  { name: '济南呼啸文化传媒有限公司', regCapital: '2万人民币' },
  { name: '济南儒扬文化传媒有限公司', regCapital: '3万人民币' },
  { name: '南京集梦文化传媒有限公司', regCapital: '50万人民币' },
  { name: '获客（南京）文化传媒有限公司', regCapital: '1万人民币' },
  { name: '南京两个果文化传媒有限公司', regCapital: '50万人民币' },
  { name: '南京鹿林文化传媒有限公司', regCapital: '20万人民币' }
];

const shuffled = candidates
  .map((item) => ({ item, sort: Math.random() }))
  .sort((a, b) => a.sort - b.sort)
  .map(({ item }) => item);

const ruleIds = [
  ['suspicious-relations', '电话邮箱等疑似关系等级'],
  ['legal-network', '法人关联企业等级'],
  ['execution', '执行失信限高冻结等级'],
  ['continuity', '严重违法与存续等级'],
  ['address', '注册地址等级'],
  ['history', '历史名称等级'],
  ['age', '主体年限等级'],
  ['staff', '社保人员等级'],
  ['other-records', '其它司法行政记录等级']
];

const csvHeaders = [
  '序号','企业名称','统一社会信用代码','法定代表人','经营状态','成立日期','注册资本','行业','注册地址',
  '社保情况','法人及疑似关系情况','疑似相同电话数量','疑似相同邮箱数量', ...ruleIds.map(([, title]) => title),
  '总体风险等级','结论','风险触发项','已检查无问题项','天眼查链接','评估时间'
];

function csvCell(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function score(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const url = `http://127.0.0.1:4173/api/company-risk?name=${encodeURIComponent(candidate.name)}`;
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.detail || `HTTP ${response.status}`);
    const byId = Object.fromEntries(data.rules.map((item) => [item.id, item]));
    const relationEvidence = byId['suspicious-relations']?.evidence || [];
    const countFromEvidence = (label) => {
      const item = relationEvidence.find((entry) => String(entry.label || '').includes(label));
      if (!item) return 0;
      const matched = String(item.value || '').match(/\d+/);
      return matched ? Number(matched[0]) : 0;
    };
    return {
      企业名称: data.company.name,
      统一社会信用代码: data.company.creditCode,
      法定代表人: data.company.legalPerson,
      经营状态: data.company.status,
      成立日期: String(data.company.established || '').slice(0, 10),
      注册资本: candidate.regCapital,
      行业: data.company.industry,
      注册地址: data.company.address,
      社保情况: byId.staff?.summary,
      法人及疑似关系情况: `${byId['legal-network']?.summary || ''}；${byId['suspicious-relations']?.summary || ''}`,
      疑似相同电话数量: countFromEvidence('疑似相同电话'),
      疑似相同邮箱数量: countFromEvidence('疑似相同邮箱'),
      levels: Object.fromEntries(ruleIds.map(([id]) => [id, byId[id]?.levelLabel ?? ''])),
      总体风险等级: data.riskLabel,
      结论: data.verdict,
      风险触发项: (data.triggers || []).join('；'),
      已检查无问题项: (data.clearChecks || []).join('；'),
      天眼查链接: data.company.tycUrl,
      评估时间: data.meta?.queriedAt || ''
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const rows = [];
  const failures = [];
  let cursor = 0;
  while (rows.length < 20 && cursor < shuffled.length) {
    const batch = shuffled.slice(cursor, cursor + 2);
    cursor += batch.length;
    const results = await Promise.all(batch.map(async (candidate) => {
      try {
        return { candidate, data: await score(candidate) };
      } catch (error) {
        return { candidate, error };
      }
    }));
    for (const result of results) {
      if (result.data && rows.length < 20) {
        rows.push(result.data);
        console.log(`[${rows.length}/20] ${result.data.企业名称}：${result.data.总体风险等级}`);
      } else if (result.error) {
        failures.push(`${result.candidate.name}: ${result.error.message}`);
        console.log(`[跳过] ${result.candidate.name}：${result.error.message}`);
      }
    }
  }
  if (rows.length < 20) throw new Error(`仅成功评估 ${rows.length} 家；${failures.join(' | ')}`);

  const lines = [csvHeaders.map(csvCell).join(',')];
  rows.forEach((row, index) => {
    const values = [
      index + 1,row.企业名称,row.统一社会信用代码,row.法定代表人,row.经营状态,row.成立日期,row.注册资本,row.行业,row.注册地址,
      row.社保情况,row.法人及疑似关系情况,row.疑似相同电话数量,row.疑似相同邮箱数量,
      ...ruleIds.map(([id]) => row.levels[id]),
      row.总体风险等级,row.结论,row.风险触发项,row.已检查无问题项,row.天眼查链接,row.评估时间
    ];
    lines.push(values.map(csvCell).join(','));
  });

  const output = path.join(__dirname, '..', '文化传媒小微企业风险等级_20家_当前规则.csv');
  fs.writeFileSync(output, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  console.log(`完成：${output}`);
  if (failures.length) console.log(`跳过 ${failures.length} 家：${failures.join(' | ')}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
