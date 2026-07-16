    const form = document.getElementById('searchForm');
    const input = document.getElementById('companyInput');
    const button = document.getElementById('submitButton');
    const result = document.getElementById('result');
    const loading = document.getElementById('loading');
    const errorBox = document.getElementById('errorBox');
    const suggestionBox = document.getElementById('companySuggestions');
    let suggestionItems = [];
    let activeSuggestion = -1;
    let searchTimer;
    let searchController;

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;'
    }[char]));

    function render(data) {
      const company = data.company;
      const companyLink = document.getElementById('companyLink');
      companyLink.textContent = company.name;
      companyLink.href = company.tycUrl;
      document.getElementById('tycLink').href = company.tycUrl;
      document.getElementById('companyCard').dataset.href = company.tycUrl;
      document.getElementById('companyMeta').innerHTML = [
        `<span class="status-pill">${escapeHtml(company.status || '状态未披露')}</span>`,
        company.creditCode ? `<span>${escapeHtml(company.creditCode)}</span>` : '',
        company.industry ? `<span>${escapeHtml(company.industry)}</span>` : '',
        company.legalPerson ? `<span>法定代表人：${escapeHtml(company.legalPerson)}</span>` : ''
      ].filter(Boolean).join('');
      document.getElementById('verdict').textContent = data.verdict;
      const riskPanel = document.getElementById('riskPanel');
      riskPanel.className = `risk-panel ${escapeHtml(data.riskLevel)}`;
      document.getElementById('riskLabel').textContent = data.riskLabel;
      document.getElementById('riskExplanationCard').className = `risk-explanation ${escapeHtml(data.riskLevel)}`;
      document.getElementById('riskExplanation').textContent = data.riskExplanation;

      const flags = document.getElementById('flags');
      flags.innerHTML = data.triggers.length
        ? data.triggers.map((flag) => `<span class="flag">${escapeHtml(flag)}</span>`).join('')
        : '<span class="flag" style="color:#c6f3dd;background:rgba(31,166,125,.14);border-color:rgba(115,221,179,.2)">未触发高、中风险规则</span>';

      document.getElementById('rules').innerHTML = data.rules.map((item, index) => {
        const evidence = item.evidence.length
          ? item.evidence.map((entry) => `<div class="evidence-item"><b>${escapeHtml(entry.label)}</b>${entry.href ? `<a href="${escapeHtml(entry.href)}" target="_blank" rel="noreferrer">${escapeHtml(entry.value)}</a>` : escapeHtml(entry.value)}</div>`).join('')
          : '<div class="empty-evidence">当前接口没有返回可展示的历史记录。</div>';
        const related = (item.relatedCompanies || []).length
          ? `<div class="related-links">${item.relatedCompanies.map((company) => `<a class="related-link ${company.riskLevel === 'high' ? 'high-risk-related' : ''}" href="${escapeHtml(company.url)}" target="_blank" rel="noreferrer" title="${escapeHtml([company.status, company.role, company.riskSummary].filter(Boolean).join(' · '))}">${escapeHtml(company.name)}${company.riskLevel === 'high' ? ' · 高风险' : ''} ↗</a>`).join('')}</div>`
          : '';
        return `<article class="rule ${escapeHtml(item.status)}">
          <div class="rule-title">
            <span class="rule-index">${String(index + 1).padStart(2, '0')}</span>
            <div><b>${escapeHtml(item.title)}</b><div class="rule-level-copy">本项判定：${escapeHtml(item.levelLabel)}</div></div>
          </div>
          <div class="rule-copy">
            <div class="rule-summary">${escapeHtml(item.summary)}</div>
            <div class="rule-reason">${escapeHtml(item.reason)}</div>
            ${related}
            <div class="evidence">
              <button class="evidence-btn" type="button" aria-expanded="false">查看详细依据</button>
              <div class="tooltip" role="tooltip"><h4>${escapeHtml(item.title)} · 详细依据</h4><div class="evidence-list">${evidence}</div></div>
            </div>
          </div>
          <div class="level-pill">${escapeHtml(item.levelLabel)}</div>
        </article>`;
      }).join('');

      document.getElementById('clearChecks').textContent = data.clearChecks.length
        ? `已经检查了 ${data.clearChecks.join('、')}，均无问题。`
        : '本次没有可确认“已检查且无问题”的红线项目。';

      const coverage = data.dataAvailability || { available:[], derived:[], unavailable:[] };
      document.getElementById('coverage').innerHTML = [
        ['available', '可直接查询', coverage.available],
        ['derived', '可二次计算', coverage.derived],
        ['unavailable', '需接自有数据', coverage.unavailable]
      ].map(([type, title, items]) => `<div class="coverage-card ${type}"><b>${title}</b><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`).join('');

      document.getElementById('note').textContent = data.meta.note;
      document.querySelectorAll('.evidence-btn').forEach((trigger) => {
        trigger.addEventListener('click', () => {
          const wrapper = trigger.closest('.evidence');
          const open = wrapper.classList.toggle('open');
          trigger.setAttribute('aria-expanded', String(open));
        });
      });
    }

    async function query(name) {
      closeSuggestions();
      result.classList.remove('show');
      errorBox.classList.remove('show');
      loading.classList.add('show');
      button.disabled = true;
      button.textContent = '评估中…';
      try {
        const response = await fetch(`/api/company-risk?name=${encodeURIComponent(name)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || data.error || '查询失败');
        render(data);
        closeSuggestions();
        result.classList.add('show');
        setTimeout(() => result.scrollIntoView({ behavior:'smooth', block:'start' }), 80);
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.classList.add('show');
      } finally {
        loading.classList.remove('show');
        button.disabled = false;
        button.textContent = '开始评估';
      }
    }

    function closeSuggestions() {
      suggestionBox.classList.remove('show');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      activeSuggestion = -1;
    }

    function setActiveSuggestion(index) {
      const options = suggestionBox.querySelectorAll('.suggestion');
      if (!options.length) return;
      activeSuggestion = (index + options.length) % options.length;
      options.forEach((option, optionIndex) => option.classList.toggle('active', optionIndex === activeSuggestion));
      const active = options[activeSuggestion];
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block:'nearest' });
    }

    function renderSuggestions(items) {
      suggestionItems = items;
      activeSuggestion = -1;
      if (!items.length) {
        suggestionBox.innerHTML = '<div class="suggestion-empty">没有找到匹配企业，请尝试更多关键词</div>';
      } else {
        suggestionBox.innerHTML = items.map((item, index) => {
          const closed = /注销|吊销|撤销/.test(item.status);
          return `<button class="suggestion" type="button" role="option" id="company-option-${index}" data-index="${index}">
            <span class="suggestion-top"><span class="suggestion-name">${escapeHtml(item.name)}</span><span class="suggestion-status ${closed ? 'closed' : ''}">${escapeHtml(item.status)}</span></span>
            <span class="suggestion-meta">
              ${item.legalPerson ? `<span>法人：${escapeHtml(item.legalPerson)}</span>` : ''}
              ${item.established ? `<span>成立：${escapeHtml(item.established)}</span>` : ''}
              ${item.registeredCapital ? `<span>${escapeHtml(item.registeredCapital)}</span>` : ''}
            </span>
          </button>`;
        }).join('');
      }
      suggestionBox.classList.add('show');
      input.setAttribute('aria-expanded', 'true');
    }

    async function fuzzySearch(value) {
      if (searchController) searchController.abort();
      searchController = new AbortController();
      try {
        const response = await fetch(`/api/company-search?q=${encodeURIComponent(value)}`, { signal:searchController.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '候选搜索失败');
        if (input.value.trim() === value) renderSuggestions(data.items || []);
      } catch (error) {
        if (error.name !== 'AbortError') {
          suggestionBox.innerHTML = `<div class="suggestion-empty">${escapeHtml(error.message)}</div>`;
          suggestionBox.classList.add('show');
        }
      }
    }

    function selectSuggestion(index) {
      const company = suggestionItems[index];
      if (!company) return;
      input.value = company.name;
      closeSuggestions();
      query(company.name);
    }

    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const value = input.value.trim();
      if (value.length < 2) {
        closeSuggestions();
        return;
      }
      searchTimer = setTimeout(() => fuzzySearch(value), 260);
    });

    input.addEventListener('keydown', (event) => {
      if (!suggestionBox.classList.contains('show') || !suggestionItems.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveSuggestion(activeSuggestion + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveSuggestion(activeSuggestion - 1);
      } else if (event.key === 'Enter' && activeSuggestion >= 0) {
        event.preventDefault();
        selectSuggestion(activeSuggestion);
      } else if (event.key === 'Escape') {
        closeSuggestions();
      }
    });

    suggestionBox.addEventListener('click', (event) => {
      const option = event.target.closest('.suggestion');
      if (!option) return;
      selectSuggestion(Number(option.dataset.index));
    });

    document.addEventListener('click', (event) => {
      if (!event.target.closest('.search-wrap')) closeSuggestions();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (name.length < 2) {
        errorBox.textContent = '请输入完整企业名称';
        errorBox.classList.add('show');
        return;
      }
      query(name);
    });

    const companyCard = document.getElementById('companyCard');
    const openCompanyPage = (event) => {
      if (event.target.closest('a, button')) return;
      if (companyCard.dataset.href) window.open(companyCard.dataset.href, '_blank', 'noopener,noreferrer');
    };
    companyCard.addEventListener('click', openCompanyPage);
    companyCard.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openCompanyPage(event);
      }
    });
