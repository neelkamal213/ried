// Shared renderer for a founder's onboarding profile — used both on the
// review step of profile-setup.html (before submit) and on the profile
// summary card in dashboard.html (after submit). Keeping this in one place
// means the two views can never drift out of sync.

function esc(v) {
  if (v === undefined || v === null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function row(label, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<div class="profile-row"><span class="profile-row-label">${esc(label)}</span><span class="profile-row-value">${esc(value)}</span></div>`;
}

function section(title, innerHTML) {
  if (!innerHTML) return '';
  return `<div class="profile-summary-section"><h4>${esc(title)}</h4>${innerHTML}</div>`;
}

export const IS_INDIVIDUAL_VALUE = 'Individual / No Company Yet';

export function renderProfileSummaryHTML(p) {
  if (!p) return '<p style="color:var(--muted)">No profile data yet.</p>';

  const isIndividual = p.entityType === IS_INDIVIDUAL_VALUE;

  const logoBlock = p.logoURL
    ? `<div class="profile-logo-preview"><img src="${esc(p.logoURL)}" alt="Logo"></div>`
    : '';

  const basics = [
    row('Full Name', p.fullName),
    row('Brand Name', p.brandName),
    row('Entity Type', p.entityType === 'Others' ? (p.entityTypeOther || 'Other') : p.entityType),
    row('Phase', p.companyPhase),
    row('Domain', p.domain === 'Something else...' ? (p.domainOther || 'Other') : p.domain)
  ].join('');

  let companyBlock = '';
  if (!isIndividual) {
    const details = [
      row('Registered Address', p.registeredAddress),
      row('Total Shareholders', p.totalShareholders),
      row('CIN', p.cin),
      row('GST No.', p.gstNo)
    ].join('');

    const signatory = [
      row('Name', p.signatoryName),
      row('Designation', p.signatoryDesignation),
      row('Phone', p.signatoryPhone),
      row('Email', p.signatoryEmail)
    ].join('');

    const poc = [
      row('Name', p.pocName),
      row('Designation', p.pocDesignation),
      row('Phone', p.pocPhone),
      row('Email', p.pocEmail)
    ].join('');

    companyBlock =
      section('Company Details', details) +
      section('Authorised Signatory', signatory) +
      section('Company Point of Contact', poc);
  }

  let founderBlock = '';
  if (isIndividual && Array.isArray(p.founderAnswers) && p.founderAnswers.length) {
    const qa = p.founderAnswers
      .map(
        (a) =>
          `<div class="profile-qa"><div class="profile-qa-q">${esc(a.question)}</div><div class="profile-qa-a">${esc(a.answer)}</div></div>`
      )
      .join('');
    founderBlock = section('Founder Discovery Answers', qa);
  }

  const extraBlock = section('Anything Else', p.additionalInfo ? `<p class="profile-extra">${esc(p.additionalInfo)}</p>` : '');

  return `
    ${logoBlock}
    ${section('Basics', basics)}
    ${companyBlock}
    ${founderBlock}
    ${extraBlock}
  `;
}
