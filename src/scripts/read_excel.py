import zipfile
import os

file_path = r"C:\Users\tech solutionor\Downloads\CF PD Notes (1).xlsx"
print("File exists:", os.path.exists(file_path))
if os.path.exists(file_path):
    with zipfile.ZipFile(file_path, 'r') as zip_ref:
        print("Zip files:")
        for name in zip_ref.namelist():
            print(name)
            if 'sharedStrings' in name or 'sheet' in name:
                print(f"--- Content of {name} (first 800 chars) ---")
                with zip_ref.open(name) as f:
                    content = f.read(800)
                    print(content.decode('utf-8', errors='ignore'))
                    print("\n")
