-- Local iam_test only. Apply through the IAM administration workflow in other environments.
-- Adds the V1.1 agreement permission and lets employees request only their linked receiving code.
START TRANSACTION;

INSERT INTO system_api_resource (client_id, code, name, method, path, status, creator, updater)
SELECT 'crowdfunding', 'crowdfunding:agreement:manage', '免责协议管理', 'ANY', '/api/agreements/**', 0, 'v11-local', 'v11-local'
WHERE NOT EXISTS (
  SELECT 1 FROM system_api_resource
  WHERE client_id = 'crowdfunding' AND code = 'crowdfunding:agreement:manage' AND deleted = b'0'
);

INSERT INTO system_menu (client_id, parent_id, name, component_name, type, sort, visible, permission, status, tenant_id)
SELECT 'crowdfunding', parent.id, '免责协议管理', 'agreements', 2, 30, 0, 'crowdfunding:agreement:manage', 0, 0
FROM system_menu parent
WHERE parent.client_id = 'crowdfunding' AND parent.component_name = 'crowdfunding'
  AND parent.tenant_id = 0 AND parent.deleted = b'0'
  AND NOT EXISTS (
    SELECT 1 FROM system_menu
    WHERE client_id = 'crowdfunding' AND permission = 'crowdfunding:agreement:manage' AND deleted = b'0'
  );

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource
  ON resource.client_id = 'crowdfunding' AND resource.code = 'crowdfunding:agreement:manage' AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (
    SELECT 1 FROM system_role_api grant_row
    WHERE grant_row.role_id = role.id AND grant_row.api_resource_id = resource.id
      AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0'
  );

INSERT INTO system_role_menu (role_id, menu_id, tenant_id)
SELECT role.id, menu.id, 0
FROM system_role role JOIN system_menu menu
  ON menu.client_id = 'crowdfunding' AND menu.permission = 'crowdfunding:agreement:manage'
  AND menu.tenant_id = 0 AND menu.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (
    SELECT 1 FROM system_role_menu grant_row
    WHERE grant_row.role_id = role.id AND grant_row.menu_id = menu.id
      AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0'
  );

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource
  ON resource.client_id = 'crowdfunding' AND resource.code = 'crowdfunding:receiving-code:query' AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_employee' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (
    SELECT 1 FROM system_role_api grant_row
    WHERE grant_row.role_id = role.id AND grant_row.api_resource_id = resource.id
      AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0'
  );

INSERT INTO system_api_resource (client_id, code, name, method, path, status, creator, updater)
SELECT 'crowdfunding', 'crowdfunding:procurement-payment:register', '采购付款登记', 'POST', '/api/projects/*/procurement-payment', 0, 'v11-local', 'v11-local'
WHERE NOT EXISTS (SELECT 1 FROM system_api_resource WHERE client_id = 'crowdfunding'
  AND code = 'crowdfunding:procurement-payment:register' AND deleted = b'0');

INSERT INTO system_api_resource (client_id, code, name, method, path, status, creator, updater)
SELECT 'crowdfunding', 'crowdfunding:procurement-payment:proof-upload', '采购付款凭证上传', 'POST', '/api/projects/*/procurement-payment/proofs', 0, 'v11-local', 'v11-local'
WHERE NOT EXISTS (SELECT 1 FROM system_api_resource WHERE client_id = 'crowdfunding'
  AND code = 'crowdfunding:procurement-payment:proof-upload' AND deleted = b'0');

INSERT INTO system_menu (client_id, parent_id, name, component_name, type, sort, visible, permission, status, tenant_id)
SELECT 'crowdfunding', parent.id, '采购付款登记', 'procurementPayment', 2, 40, 0,
  'crowdfunding:procurement-payment:register', 0, 0
FROM system_menu parent
WHERE parent.client_id = 'crowdfunding' AND parent.component_name = 'crowdfunding'
  AND parent.tenant_id = 0 AND parent.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_menu WHERE client_id = 'crowdfunding'
    AND permission = 'crowdfunding:procurement-payment:register' AND deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:procurement-payment:register', 'crowdfunding:procurement-payment:proof-upload')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_menu (role_id, menu_id, tenant_id)
SELECT role.id, menu.id, 0
FROM system_role role JOIN system_menu menu ON menu.client_id = 'crowdfunding'
  AND menu.permission = 'crowdfunding:procurement-payment:register' AND menu.tenant_id = 0 AND menu.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_menu grant_row WHERE grant_row.role_id = role.id
    AND grant_row.menu_id = menu.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_api_resource (client_id, code, name, method, path, status, creator, updater)
SELECT 'crowdfunding', codes.code, codes.name, codes.method, codes.path, 0, 'v11-local', 'v11-local'
FROM (
  SELECT 'crowdfunding:receipt:query' AS code, '客户回款查询' AS name, 'GET' AS method, '/api/receipt-batches' AS path
  UNION ALL SELECT 'crowdfunding:receipt:register', '客户回款登记', 'POST', '/api/receipt-batches'
  UNION ALL SELECT 'crowdfunding:receipt:proof-upload', '回款凭证上传', 'POST', '/api/projects/*/receipt-proofs'
  UNION ALL SELECT 'crowdfunding:receipt:review', '客户回款及公司补款复核', 'POST', '/api/receipt-batches/*/review'
  UNION ALL SELECT 'crowdfunding:receipt:difference-register', '回款差异去向登记', 'POST', '/api/projects/*/receipt-differences'
  UNION ALL SELECT 'crowdfunding:distribution:query', '利润分配查询', 'GET', '/api/distribution-orders'
  UNION ALL SELECT 'crowdfunding:distribution:generate', '生成分配单', 'POST', '/api/projects/*/distribution-orders'
  UNION ALL SELECT 'crowdfunding:distribution:approve', '审批分配单', 'POST', '/api/distribution-orders/*/approve'
  UNION ALL SELECT 'crowdfunding:distribution:reject', '驳回分配单', 'POST', '/api/distribution-orders/*/reject'
  UNION ALL SELECT 'crowdfunding:distribution:void', '作废分配单', 'POST', '/api/distribution-orders/*/void'
  UNION ALL SELECT 'crowdfunding:distribution:close', '利润分配结单', 'POST', '/api/distribution-orders/*/close'
  UNION ALL SELECT 'crowdfunding:cost:query', '其他成本查询', 'GET', '/api/confirmed-costs'
  UNION ALL SELECT 'crowdfunding:cost:register', '其他成本登记', 'POST', '/api/confirmed-costs'
  UNION ALL SELECT 'crowdfunding:cost:proof-upload', '其他成本凭证上传', 'POST', '/api/projects/*/confirmed-cost-proofs'
  UNION ALL SELECT 'crowdfunding:cost:review', '其他成本公司复核', 'POST', '/api/confirmed-costs/*/review'
  UNION ALL SELECT 'crowdfunding:payout:my-query', '我的分配收益', 'GET', '/api/my-distribution-payouts'
  UNION ALL SELECT 'crowdfunding:payout:register', '逐人打款登记', 'POST', '/api/distribution-orders/*/lines/*/payout'
  UNION ALL SELECT 'crowdfunding:payout:proof-upload', '分配打款凭证上传', 'POST', '/api/distribution-orders/*/lines/*/proofs'
  UNION ALL SELECT 'crowdfunding:payout:confirm', '员工确认分配收款', 'POST', '/api/distribution-orders/*/lines/*/confirm'
  UNION ALL SELECT 'crowdfunding:payout:issue-reply', '回复收款异议', 'POST', '/api/distribution-orders/*/lines/*/issue-reply'
  UNION ALL SELECT 'crowdfunding:financial-reconciliation:query', '结单前资金对账', 'GET', '/api/projects/*/financial-reconciliation'
) codes
WHERE NOT EXISTS (SELECT 1 FROM system_api_resource resource WHERE resource.client_id = 'crowdfunding'
  AND resource.code = codes.code AND resource.deleted = b'0');

INSERT INTO system_menu (client_id, parent_id, name, component_name, type, sort, visible, permission, status, tenant_id)
SELECT 'crowdfunding', parent.id, '客户回款', 'customerReceipts', 2, 50, 0, 'crowdfunding:receipt:query', 0, 0
FROM system_menu parent
WHERE parent.client_id = 'crowdfunding' AND parent.component_name = 'crowdfunding'
  AND parent.tenant_id = 0 AND parent.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_menu WHERE client_id = 'crowdfunding'
    AND permission = 'crowdfunding:receipt:query' AND deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:receipt:query', 'crowdfunding:receipt:register',
    'crowdfunding:receipt:proof-upload', 'crowdfunding:receipt:review',
    'crowdfunding:receipt:difference-register') AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:receipt:query', 'crowdfunding:receipt:review') AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:payout:register', 'crowdfunding:payout:proof-upload',
    'crowdfunding:payout:issue-reply')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:payout:my-query', 'crowdfunding:payout:confirm')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_employee' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_menu (client_id, parent_id, name, component_name, type, sort, visible, permission, status, tenant_id)
SELECT 'crowdfunding', parent.id, '我的收益', 'myPayouts', 2, 15, 0,
  'crowdfunding:payout:my-query', 0, 0
FROM system_menu parent
WHERE parent.client_id = 'crowdfunding' AND parent.component_name = 'crowdfunding'
  AND parent.tenant_id = 0 AND parent.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_menu WHERE client_id = 'crowdfunding'
    AND permission = 'crowdfunding:payout:my-query' AND deleted = b'0');

INSERT INTO system_role_menu (role_id, menu_id, tenant_id)
SELECT role.id, menu.id, 0
FROM system_role role JOIN system_menu menu ON menu.client_id = 'crowdfunding'
  AND menu.permission = 'crowdfunding:payout:my-query' AND menu.tenant_id = 0 AND menu.deleted = b'0'
WHERE role.code = 'crowdfunding_employee' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_menu grant_row WHERE grant_row.role_id = role.id
    AND grant_row.menu_id = menu.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_menu (role_id, menu_id, tenant_id)
SELECT role.id, menu.id, 0
FROM system_role role JOIN system_menu menu ON menu.client_id = 'crowdfunding'
  AND menu.permission = 'crowdfunding:receipt:query' AND menu.tenant_id = 0 AND menu.deleted = b'0'
WHERE role.code IN ('crowdfunding_finance', 'crowdfunding_super_admin') AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_menu grant_row WHERE grant_row.role_id = role.id
    AND grant_row.menu_id = menu.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_menu (client_id, parent_id, name, component_name, type, sort, visible, permission, status, tenant_id)
SELECT 'crowdfunding', parent.id, '利润分配', 'distributionOrders', 2, 60, 0,
  'crowdfunding:distribution:query', 0, 0
FROM system_menu parent
WHERE parent.client_id = 'crowdfunding' AND parent.component_name = 'crowdfunding'
  AND parent.tenant_id = 0 AND parent.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_menu WHERE client_id = 'crowdfunding'
    AND permission = 'crowdfunding:distribution:query' AND deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:distribution:query', 'crowdfunding:distribution:generate',
    'crowdfunding:distribution:approve', 'crowdfunding:distribution:reject',
    'crowdfunding:distribution:void', 'crowdfunding:distribution:close') AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code = 'crowdfunding:distribution:query' AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_menu (role_id, menu_id, tenant_id)
SELECT role.id, menu.id, 0
FROM system_role role JOIN system_menu menu ON menu.client_id = 'crowdfunding'
  AND menu.permission = 'crowdfunding:distribution:query' AND menu.tenant_id = 0 AND menu.deleted = b'0'
WHERE role.code IN ('crowdfunding_finance', 'crowdfunding_super_admin') AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_menu grant_row WHERE grant_row.role_id = role.id
    AND grant_row.menu_id = menu.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code = 'crowdfunding:financial-reconciliation:query' AND resource.deleted = b'0'
WHERE role.code IN ('crowdfunding_finance', 'crowdfunding_super_admin')
  AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:cost:query', 'crowdfunding:cost:register',
    'crowdfunding:cost:proof-upload') AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:cost:query', 'crowdfunding:cost:review') AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_api_resource (client_id, code, name, method, path, status, creator, updater)
SELECT 'crowdfunding', codes.code, codes.name, codes.method, codes.path, 0, 'v11-local', 'v11-local'
FROM (
  SELECT 'crowdfunding:exception-fund:query' AS code, '异常款项查询' AS name, 'GET' AS method, '/api/exception-funds' AS path
  UNION ALL SELECT 'crowdfunding:exception-fund:register', '异常款项登记', 'POST', '/api/exception-funds'
  UNION ALL SELECT 'crowdfunding:exception-fund:proof-upload', '异常款项凭证上传', 'POST', '/api/exception-funds/proofs'
  UNION ALL SELECT 'crowdfunding:exception-fund:refund', '异常款项退回登记', 'POST', '/api/exception-funds/*/refunds'
  UNION ALL SELECT 'crowdfunding:exception-fund:refund-proof-upload', '异常款项退回凭证上传', 'POST', '/api/exception-funds/*/refund-proofs'
  UNION ALL SELECT 'crowdfunding:exception-fund:refund-confirm', '异常款项退回确认', 'POST', '/api/exception-funds/*/refunds/*/confirm'
  UNION ALL SELECT 'crowdfunding:exception-fund:my-refunds', '我的异常款项退回', 'GET', '/api/my-exception-refunds'
  UNION ALL SELECT 'crowdfunding:exception-fund:transfer', '异常款项转入认购单', 'POST', '/api/exception-funds/*/transfers'
  UNION ALL SELECT 'crowdfunding:exception-fund:transfer-review', '异常款项转入公司复核', 'POST', '/api/exception-funds/*/transfers/*/review'
  UNION ALL SELECT 'crowdfunding:exception-fund:assign-project', '核实异常款项归属', 'POST', '/api/exception-funds/*/assign-project'
) codes
WHERE NOT EXISTS (SELECT 1 FROM system_api_resource resource WHERE resource.client_id = 'crowdfunding'
  AND resource.code = codes.code AND resource.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:exception-fund:query', 'crowdfunding:exception-fund:register',
    'crowdfunding:exception-fund:proof-upload', 'crowdfunding:exception-fund:refund',
    'crowdfunding:exception-fund:refund-proof-upload', 'crowdfunding:exception-fund:transfer',
    'crowdfunding:exception-fund:assign-project') AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:exception-fund:query', 'crowdfunding:exception-fund:refund-confirm',
    'crowdfunding:exception-fund:transfer-review')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:exception-fund:my-refunds', 'crowdfunding:exception-fund:refund-confirm')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_employee' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_menu (client_id, parent_id, name, component_name, type, sort, visible, permission, status, tenant_id)
SELECT 'crowdfunding', parent.id, '异常款项', 'exceptionFunds', 2, 65, 0, 'crowdfunding:exception-fund:query', 0, 0
FROM system_menu parent
WHERE parent.client_id = 'crowdfunding' AND parent.component_name = 'crowdfunding'
  AND parent.tenant_id = 0 AND parent.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_menu WHERE client_id = 'crowdfunding'
    AND permission = 'crowdfunding:exception-fund:query' AND deleted = b'0');

INSERT INTO system_role_menu (role_id, menu_id, tenant_id)
SELECT role.id, menu.id, 0
FROM system_role role JOIN system_menu menu ON menu.client_id = 'crowdfunding'
  AND menu.permission = 'crowdfunding:exception-fund:query' AND menu.tenant_id = 0 AND menu.deleted = b'0'
WHERE role.code IN ('crowdfunding_finance', 'crowdfunding_super_admin') AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_menu grant_row WHERE grant_row.role_id = role.id
    AND grant_row.menu_id = menu.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_api_resource (client_id, code, name, method, path, status, creator, updater)
SELECT 'crowdfunding', codes.code, codes.name, codes.method, codes.path, 0, 'v11-local', 'v11-local'
FROM (
  SELECT 'crowdfunding:project:close' AS code, '关闭众筹单' AS name, 'POST' AS method, '/api/projects/*/close' AS path
  UNION ALL SELECT 'crowdfunding:project:reopen', '重开已关闭众筹单', 'POST', '/api/projects/*/reopen'
  UNION ALL SELECT 'crowdfunding:project:finish-close', '完成众筹关闭', 'POST', '/api/projects/*/finish-close'
  UNION ALL SELECT 'crowdfunding:project-refund:query', '项目退款查询', 'GET', '/api/project-refunds'
  UNION ALL SELECT 'crowdfunding:project-refund:my-query', '我的项目退款', 'GET', '/api/my-project-refunds'
  UNION ALL SELECT 'crowdfunding:project-refund:proof-upload', '项目退款凭证上传', 'POST', '/api/project-refunds/*/proofs'
  UNION ALL SELECT 'crowdfunding:project-refund:register', '登记项目退款', 'POST', '/api/project-refunds/*/payment'
  UNION ALL SELECT 'crowdfunding:project-refund:confirm', '员工确认项目退款', 'POST', '/api/project-refunds/*/confirm'
) codes
WHERE NOT EXISTS (SELECT 1 FROM system_api_resource resource WHERE resource.client_id = 'crowdfunding'
  AND resource.code = codes.code AND resource.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:project:close', 'crowdfunding:project:reopen') AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:project:finish-close', 'crowdfunding:project-refund:query',
    'crowdfunding:project-refund:proof-upload', 'crowdfunding:project-refund:register')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code = 'crowdfunding:project-refund:query' AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:project-refund:my-query', 'crowdfunding:project-refund:confirm')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_employee' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_menu (client_id, parent_id, name, component_name, type, sort, visible, permission, status, tenant_id)
SELECT 'crowdfunding', parent.id, '项目退款', 'projectRefunds', 2, 66, 0, 'crowdfunding:project-refund:query', 0, 0
FROM system_menu parent
WHERE parent.client_id = 'crowdfunding' AND parent.component_name = 'crowdfunding'
  AND parent.tenant_id = 0 AND parent.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_menu WHERE client_id = 'crowdfunding'
    AND permission = 'crowdfunding:project-refund:query' AND deleted = b'0');

INSERT INTO system_role_menu (role_id, menu_id, tenant_id)
SELECT role.id, menu.id, 0
FROM system_role role JOIN system_menu menu ON menu.client_id = 'crowdfunding'
  AND menu.permission = 'crowdfunding:project-refund:query' AND menu.tenant_id = 0 AND menu.deleted = b'0'
WHERE role.code IN ('crowdfunding_finance', 'crowdfunding_super_admin') AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_menu grant_row WHERE grant_row.role_id = role.id
    AND grant_row.menu_id = menu.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

COMMIT;

-- V1.1 采购失败终止与供应商退款权限
INSERT INTO system_api_resource (client_id, code, name, method, path, status, creator, updater)
SELECT 'crowdfunding', codes.code, codes.name, codes.method, codes.path, 0, 'v11-local', 'v11-local'
FROM (
  SELECT 'crowdfunding:procurement-failure:request' AS code, '申请采购失败终止' AS name, 'POST' AS method, '/api/projects/*/procurement-failure' AS path
  UNION ALL SELECT 'crowdfunding:procurement-failure:query', '查询采购失败申请', 'GET', '/api/procurement-failure-requests'
  UNION ALL SELECT 'crowdfunding:procurement-failure:review', '复核采购失败申请', 'POST', '/api/procurement-failure-requests/*/review'
  UNION ALL SELECT 'crowdfunding:procurement-failure:finish', '完成采购失败终止', 'POST', '/api/projects/*/finish-procurement-failure'
  UNION ALL SELECT 'crowdfunding:supplier-refund:query', '供应商退款查询', 'GET', '/api/supplier-refunds'
  UNION ALL SELECT 'crowdfunding:supplier-refund:proof-upload', '供应商退款凭证上传', 'POST', '/api/projects/*/supplier-refund-proofs'
  UNION ALL SELECT 'crowdfunding:supplier-refund:register', '供应商退款登记', 'POST', '/api/projects/*/supplier-refunds'
) codes
WHERE NOT EXISTS (SELECT 1 FROM system_api_resource resource WHERE resource.client_id = 'crowdfunding'
  AND resource.code = codes.code AND resource.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:procurement-failure:request', 'crowdfunding:procurement-failure:query')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:procurement-failure:query', 'crowdfunding:procurement-failure:review',
    'crowdfunding:supplier-refund:query') AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:procurement-failure:finish', 'crowdfunding:supplier-refund:query',
    'crowdfunding:supplier-refund:proof-upload', 'crowdfunding:supplier-refund:register')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_menu (client_id, parent_id, name, component_name, type, sort, visible, permission, status, tenant_id)
SELECT 'crowdfunding', parent.id, '采购失败终止', 'procurementFailure', 2, 67, 0,
  'crowdfunding:procurement-failure:query', 0, 0
FROM system_menu parent
WHERE parent.client_id = 'crowdfunding' AND parent.component_name = 'crowdfunding'
  AND parent.tenant_id = 0 AND parent.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_menu WHERE client_id = 'crowdfunding'
    AND component_name = 'procurementFailure' AND tenant_id = 0 AND deleted = b'0');

INSERT INTO system_role_menu (role_id, menu_id, tenant_id)
SELECT role.id, menu.id, 0
FROM system_role role JOIN system_menu menu ON menu.client_id = 'crowdfunding'
  AND menu.component_name = 'procurementFailure' AND menu.tenant_id = 0 AND menu.deleted = b'0'
WHERE role.code IN ('crowdfunding_admin', 'crowdfunding_finance', 'crowdfunding_super_admin')
  AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_menu grant_row WHERE grant_row.role_id = role.id
    AND grant_row.menu_id = menu.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

-- V1.1 采购失败时已复核回款的原单退回
INSERT INTO system_api_resource (client_id, code, name, method, path, status, creator, updater)
SELECT 'crowdfunding', codes.code, codes.name, codes.method, codes.path, 0, 'v11-local', 'v11-local'
FROM (
  SELECT 'crowdfunding:receipt-termination-refund:query' AS code, '采购失败原回款退回查询' AS name, 'GET' AS method, '/api/receipt-termination-refunds' AS path
  UNION ALL SELECT 'crowdfunding:receipt-termination-refund:proof-upload', '采购失败原回款退回凭证', 'POST', '/api/projects/*/receipt-termination-refund-proofs'
  UNION ALL SELECT 'crowdfunding:receipt-termination-refund:register', '登记采购失败原回款退回', 'POST', '/api/projects/*/receipt-termination-refunds'
  UNION ALL SELECT 'crowdfunding:receipt-termination-refund:review', '复核采购失败原回款退回', 'POST', '/api/receipt-termination-refunds/*/review'
) codes
WHERE NOT EXISTS (SELECT 1 FROM system_api_resource resource WHERE resource.client_id = 'crowdfunding'
  AND resource.code = codes.code AND resource.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:receipt-termination-refund:query',
    'crowdfunding:receipt-termination-refund:proof-upload', 'crowdfunding:receipt-termination-refund:register')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:receipt-termination-refund:query',
    'crowdfunding:receipt-termination-refund:review') AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

-- V1.1 员工项目退款代确认
INSERT INTO system_api_resource (client_id, code, name, method, path, status, creator, updater)
SELECT 'crowdfunding', codes.code, codes.name, codes.method, codes.path, 0, 'v11-local', 'v11-local'
FROM (
  SELECT 'crowdfunding:project-refund-proxy:query' AS code, '项目退款代确认申请查询' AS name, 'GET' AS method, '/api/project-refund-proxy-requests' AS path
  UNION ALL SELECT 'crowdfunding:project-refund-proxy:request', '申请项目退款代确认', 'POST', '/api/project-refunds/*/proxy-confirm'
  UNION ALL SELECT 'crowdfunding:project-refund-proxy:review', '复核项目退款代确认', 'POST', '/api/project-refund-proxy-requests/*/review'
) codes
WHERE NOT EXISTS (SELECT 1 FROM system_api_resource resource WHERE resource.client_id = 'crowdfunding'
  AND resource.code = codes.code AND resource.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:project-refund-proxy:query', 'crowdfunding:project-refund-proxy:request')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_finance' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');

INSERT INTO system_role_api (role_id, api_resource_id, tenant_id)
SELECT role.id, resource.id, 0
FROM system_role role JOIN system_api_resource resource ON resource.client_id = 'crowdfunding'
  AND resource.code IN ('crowdfunding:project-refund-proxy:query', 'crowdfunding:project-refund-proxy:review')
  AND resource.deleted = b'0'
WHERE role.code = 'crowdfunding_super_admin' AND role.tenant_id = 0 AND role.deleted = b'0'
  AND NOT EXISTS (SELECT 1 FROM system_role_api grant_row WHERE grant_row.role_id = role.id
    AND grant_row.api_resource_id = resource.id AND grant_row.tenant_id = 0 AND grant_row.deleted = b'0');
