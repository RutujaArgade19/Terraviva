#!/usr/bin/env python3
"""SQLite fidelity, provenance positions, and conservative operation deduplication."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import subprocess
import sys
import zipfile

from reference_fixtures import ROOT, fixture, quiet, sql_builder


class ReferenceSQLiteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def build(self, tables=None):
        _, _, base = fixture(self.directory, tables)
        output = self.directory/"result.sqlite3"
        result = quiet(sql_builder.build, base, base/"reference", output)
        return sqlite3.connect(output), result, base

    def test_sql_retains_every_cell_and_physical_source_line(self):
        connection, result, _ = self.build()
        try:
            self.assertEqual(connection.execute('SELECT * FROM fixture ORDER BY _row_number').fetchall(), [
                (1,2,'001','3.1400','a,b'),(2,4,'002',None,'line one\nline two'),
                (3,5,'003','','  '),(4,6,'004','0','NA')])
            self.assertEqual(connection.execute('PRAGMA quick_check').fetchone()[0], 'ok')
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM source_columns').fetchone()[0],3)
            self.assertEqual(result['sourceRows'],4)
        finally:
            connection.close()

    def operation_tables(self, variant='exact'):
        columns = sql_builder.OPERATION_COLUMNS
        row = ['planting','001','P-01','2021','2021-03-01','SEED','Wheat', '\\N','140.00', '\\N','\\N','\\N','\\N','\\N','not_applicable','\\N','0']
        other = row.copy()
        if variant == 'conflict':
            other[8] = '141.00'
        if variant == 'missing':
            other[1] = '\\N'
        return {'first.csv':(columns,[row]),'second.csv':(columns,[other])}

    def test_exact_repeated_exports_are_audited_without_deleting_sources(self):
        connection, result, _ = self.build(self.operation_tables())
        try:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM operation_core_all').fetchone()[0],2)
            self.assertEqual(connection.execute('SELECT source_rows,source_files,core_variants FROM operation_key_audit').fetchone(),(2,2,1))
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM operation_core_deduplicated').fetchone()[0],1)
            self.assertEqual(result['operationAudit']['repeatedKeyGroups'],1)
        finally:
            connection.close()

    def test_conflicting_shared_cells_withhold_deduplicated_view(self):
        connection, result, _ = self.build(self.operation_tables('conflict'))
        try:
            self.assertEqual(result['operationAudit']['conflictingKeyGroups'],1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='operation_core_deduplicated'").fetchone()[0],0)
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM operation_core_all').fetchone()[0],2)
        finally:
            connection.close()

    def test_missing_operation_key_withholds_deduplicated_view(self):
        connection, result, _ = self.build(self.operation_tables('missing'))
        try:
            self.assertEqual(result['operationAudit']['missingKeyRows'],1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='operation_core_deduplicated'").fetchone()[0],0)
        finally:
            connection.close()

    def test_sql_source_text_is_never_executed(self):
        connection, _, _ = self.build({'examples.csv':(['sql'],[['DROP TABLE source_catalog;'],["SELECT 'not executed';"]])})
        try:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM source_catalog').fetchone()[0],1)
            self.assertEqual(connection.execute('SELECT sql FROM examples WHERE _row_number=1').fetchone()[0],'DROP TABLE source_catalog;')
        finally:
            connection.close()

    def test_existing_database_is_never_replaced(self):
        connection, _, base = self.build()
        connection.close()
        with self.assertRaisesRegex(ValueError,'exists'):
            quiet(sql_builder.build, base, base/'reference', self.directory/'result.sqlite3')

    def test_legacy_delivery_command_produces_a_complete_zip(self):
        _, _, base = fixture(self.directory)
        output = self.directory/'delivery'
        result = subprocess.run([sys.executable, str(ROOT/'scripts/build-reference-sqlite.py'),
            '--staging-dir', str(base), '--output-dir', str(output), '--zip'], capture_output=True, text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        with zipfile.ZipFile(output/'terraviva-reference-sqlite.zip') as archive:
            self.assertEqual(set(archive.namelist()), {'terraviva-reference.sqlite3','README.md','delivery.json','CHECKSUMS.sha256'})
            self.assertIsNone(archive.testzip())


if __name__ == '__main__':
    unittest.main()
