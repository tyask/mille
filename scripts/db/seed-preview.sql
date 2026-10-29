-- Only synthetic preview/local users. Existing records are never re-enabled or overwritten.
DO $mille_seed$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mille:schema'));
  IF NOT EXISTS (SELECT 1 FROM public.mille_environment WHERE singleton = true
    AND project = 'tyask/mille' AND environment = 'preview'
    AND environment_id = 'mille-preview') THEN
      RAISE EXCEPTION 'Mille database environment mismatch';
    END IF;
  LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (SELECT 1 FROM app_users WHERE
    (id = 'mille-test-user-a' AND (email <> 'test-a@mille.invalid' OR NOT is_test))
    OR (email = 'test-a@mille.invalid' AND id <> 'mille-test-user-a')) THEN
    RAISE EXCEPTION 'Mille test user identity mismatch';
  END IF;
  INSERT INTO app_users (id,email,name,is_enabled,is_test)
    VALUES ('mille-test-user-a','test-a@mille.invalid','テストユーザーA',true,true)
    ON CONFLICT (id) DO NOTHING;

  IF EXISTS (SELECT 1 FROM app_users WHERE
    (id = 'mille-test-user-b' AND (email <> 'test-b@mille.invalid' OR NOT is_test))
    OR (email = 'test-b@mille.invalid' AND id <> 'mille-test-user-b')) THEN
    RAISE EXCEPTION 'Mille test user identity mismatch';
  END IF;
  INSERT INTO app_users (id,email,name,is_enabled,is_test)
    VALUES ('mille-test-user-b','test-b@mille.invalid','テストユーザーB',true,true)
    ON CONFLICT (id) DO NOTHING;
END; $mille_seed$;
