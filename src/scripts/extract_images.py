import zipfile
import os

file_path = r"C:\Users\tech solutionor\Downloads\CF PD Notes (1).xlsx"
dest_dir = r"C:\Users\tech solutionor\.gemini\antigravity-ide\brain\a8b3aa0b-84ff-4b17-92a0-623a8e351274"

if not os.path.exists(dest_dir):
    os.makedirs(dest_dir)

with zipfile.ZipFile(file_path, 'r') as zip_ref:
    for name in zip_ref.namelist():
        if name.startswith('xl/media/'):
            basename = os.path.basename(name)
            dest_path = os.path.join(dest_dir, basename)
            with zip_ref.open(name) as f_in, open(dest_path, 'wb') as f_out:
                f_out.write(f_in.read())
            print(f"Extracted {name} to {dest_path}")
