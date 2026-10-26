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
  UNION ALL SELECT 'crowdfunding:cost:query', '其他成本查询', 'GET', '/api/confirmed-costs'
  UNION ALL SELECT 'crowdfunding:cost:register', '其他成本登记', 'POST', '/api/confirmed-costs'
  UNION ALL SELECT 'crowdfunding:cost:proof-upload', '其他成本凭证上传', 'POST', '/api/projects/*/confirmed-cost-proofs'
  UNION ALL SELECT 'crowdfunding:cost:review', '其他成本公司复核', 'POST', '/api/confirmed-costs/*/review'
  UNION ALL SELECT 'crowdfunding:payout:my-query', '我的分配收益', 'GET', '/api/my-distribution-payouts'
  UNION ALL SELECT 'crowdfunding:payout:register', '逐人打款登记', 'POST', '/api/distribution-orders/*/lines/*/payout'
  UNION ALL SELECT 'crowdfunding:payout:proof-upload', '分配打款凭证上传', 'POST', '/api/distribution-orders/*/lines/*/proofs'
  UNION ALL SELECT 'crowdfunding:payout:confirm', '员工确认分配收款', 'POST', '/api/distribution-orders/*/lines/*/confirm'
  UNION ALL SELECT 'crowdfunding:payout:issue-reply', '回复收款异议', 'POST', '/api/distribution-orders/*/lines/*/issue-reply'
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
    'crowdfunding:distribution:void') AND resource.deleted = b'0'
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

COMMIT;
