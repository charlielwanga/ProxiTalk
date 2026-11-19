/* Phone-based ProxiTalk IDs for Ugandan mobile numbers. */
const ProxiIdentity = (() => {
  const UGANDA_MOBILE_ID = /^2567\d{8}$/;

  function normalizeUgandaPhone(value) {
    if (typeof value !== 'string') return null;
    let digits = value.trim().replace(/[\s()-]/g, '');
    if (digits.startsWith('+')) digits = digits.slice(1);
    if (/^07\d{8}$/.test(digits)) digits = '256' + digits.slice(1);
    else if (/^7\d{8}$/.test(digits)) digits = '256' + digits;
    return UGANDA_MOBILE_ID.test(digits) ? digits : null;
  }

  function isProxiTalkId(value) {
    return typeof value === 'string' && UGANDA_MOBILE_ID.test(value);
  }

  return Object.freeze({ normalizeUgandaPhone, isProxiTalkId });
})();
