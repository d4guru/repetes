-- =====================================================
-- Verrouillage : seul un utilisateur connecté (le compte groupe)
-- peut lire et écrire. Ne supprime aucune donnée.
-- À exécuter SEULEMENT après avoir déposé la nouvelle app sur GitHub.
-- Supabase > SQL Editor > New query > coller > Run
-- =====================================================

do $$
declare t text;
begin
  foreach t in array array['settings','members','rehearsals','availability','songs','setlist_items','song_progress'] loop
    execute format('drop policy if exists "acces groupe" on %I', t);
    execute format('create policy "acces groupe" on %I for all to authenticated using (true) with check (true)', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;


-- =====================================================
-- EN CAS DE PROBLÈME UNIQUEMENT : pour revenir à l'accès libre,
-- exécute le bloc ci-dessous (enlève les -- au début des lignes).
-- =====================================================
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['settings','members','rehearsals','availability','songs','setlist_items','song_progress'] loop
--     execute format('drop policy if exists "acces groupe" on %I', t);
--     execute format('create policy "acces groupe" on %I for all to anon, authenticated using (true) with check (true)', t);
--     execute format('grant select, insert, update, delete on %I to anon', t);
--   end loop;
-- end $$;
