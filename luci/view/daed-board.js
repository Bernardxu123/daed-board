'use strict';
'require view';

return view.extend({
	render: function () {
		const frame = E('iframe', {
			src: '/daed-board/',
			style: 'width:100%; min-height:calc(100vh - 11rem); border:0; border-radius:.375em; background:#0b0e14'
		});
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ 'Daed 仪表盘' ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				'zashboard 风格的 daed 监控面板 · ',
				E('a', { href: '/daed-board/', target: '_blank', rel: 'noopener' }, [ '在新窗口打开 ↗' ])
			]),
			frame
		]);
	},
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
