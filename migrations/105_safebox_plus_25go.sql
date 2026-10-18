-- Coffre-fort : l'espace avec Alanya Plus passe de 50 à 25 Go (décision du
-- 18/10/2026). Plus annuel coûte 1 000 XAF (migration 082) ; à environ 2,50 €
-- le To et par mois chez MEGA, 50 Go remplis coûtaient à peu près ce que
-- l'abonné paie. Conception : docs/conception/coffre-fort.html, section 09.
--
-- Seuls les plans restés à la valeur posée par la migration 103 (50 Gio)
-- changent : un espace réglé à la main dans l'admin n'est pas écrasé. Rien
-- n'est supprimé : un coffre au-delà de 25 Go garde tout, mais ne peut plus
-- rien ajouter tant qu'il n'est pas repassé sous son espace.
--
-- Réexécutable. Appliquer après 103.

UPDATE plan SET safebox_bytes = 26843545600 WHERE safebox_bytes = 53687091200;
