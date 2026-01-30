export const formatPercent = (n) => n ? n.toFixed(1) + '%' : '0.0%';
export const formatNumber = (n) => new Intl.NumberFormat('en-US').format(n);
