import { buildPoseidon, EddsaPublicKey, SNARK_FIELD } from "@sismo-core/crypto";
import { KVMerkleTree } from "@sismo-core/kv-merkle-tree";
import { BigNumber, BigNumberish, ethers } from "ethers";
// @ts-ignore
import { groth16 } from "snarkjs";
// import {
//   ACCOUNTS_TREE_HEIGHT,
//   PrivateInputs,
//   PublicInputs,
//   REGISTRY_TREE_HEIGHT,
// } from ".";
// import { wasmPath, zkeyPath } from "./files";
import { SnarkProof } from "./snark-proof";
import {Inputs, PrivateInputs, PublicInputs} from "./types";
import { verifyCommitment } from "./verify-commitment";

export const AddressTreeHeight = 20;
export const RegistryTreeHeight = 20;

export type CircuitPath = { wasmPath: string; zkeyPath: string } | null;

export type HydraS1Account = {
  identifier: BigNumberish;
  secret: BigNumberish;
  commitmentReceipt: [BigNumberish, BigNumberish, BigNumberish];
};

type UserParams = {
  source: HydraS1Account;
  destination: HydraS1Account;
  claimedValue: BigNumberish;
  chainId: BigNumberish;
  accountsTree: KVMerkleTree;
  externalNullifier: BigNumberish;
  isStrict: boolean;
};

export class HydraS1Prover {
  private registryTree: KVMerkleTree;
  private commitmentMapperPubKey: EddsaPublicKey;
  private esmOverrideCircuitPath: CircuitPath;

  constructor(
    registryTree: KVMerkleTree,
    commitmentMapperPubKey: EddsaPublicKey,
    esmOverrideCircuitPath: CircuitPath = null
  ) {
    this.registryTree = registryTree;
    this.commitmentMapperPubKey = commitmentMapperPubKey;
    this.esmOverrideCircuitPath = esmOverrideCircuitPath;
  }

  public async generateInputs({
    source,
    destination,
    claimedValue,
    chainId,
    accountsTree,
    externalNullifier,
  }: UserParams): Promise<Inputs> {
    source.identifier = BigNumber.from(source.identifier);
    source.secret = BigNumber.from(source.secret);
    destination.identifier = BigNumber.from(destination.identifier);
    destination.secret = BigNumber.from(destination.secret);

    claimedValue = BigNumber.from(claimedValue);
    externalNullifier = BigNumber.from(externalNullifier);
    chainId = BigNumber.from(chainId);

    const zeroPaddedSourceIdentifier = ethers.utils.hexZeroPad(
      source.identifier.toHexString(),
      20
    );

    const poseidon = await buildPoseidon();

    const accountMerklePath = accountsTree.getMerklePathFromKey(
      zeroPaddedSourceIdentifier
    );
    const sourceValue = accountsTree.getValue(zeroPaddedSourceIdentifier);

    const registryMerklePath = this.registryTree.getMerklePathFromKey(
      accountsTree.getRoot().toHexString()
    );
    const accountsTreeValue = this.registryTree.getValue(
      accountsTree.getRoot().toHexString()
    );

    const sourceSecretHash = poseidon([source.secret, 1]);
    const nullifier = poseidon([sourceSecretHash, externalNullifier]);

    const oldPrivateInputs: PrivateInputs = {
      sourceIdentifier: source.identifier.toBigInt(),
      sourceSecret: source.secret.toBigInt(),
      sourceCommitmentReceipt: source.commitmentReceipt.map((el) =>
        BigNumber.from(el).toBigInt()
      ),
      accountsTreeRoot: accountsTree.getRoot().toBigInt(),
      accountMerklePathElements: accountMerklePath.elements.map((el) =>
        el.toBigInt()
      ),
      accountMerklePathIndices: accountMerklePath.indices,
    };

    const oldPublicInputs: PublicInputs = {
      destinationIdentifier: destination.identifier.toBigInt(),
      commitmentMapperPubKey: this.commitmentMapperPubKey.map((el) =>
        el.toBigInt()
      ),
      externalNullifier: externalNullifier.toBigInt(),
      nullifier: nullifier.toBigInt(),
    };

    const selectedPrivKeys = ["sourceIdentifier", "sourceSecret", "sourceCommitmentReceipt", "accountMerklePathElements", "accountMerklePathIndices", "accountsTreeRoot"];
    const privateInputs: PrivateInputs = selectedPrivKeys.reduce((obj, key) => {
      if (oldPrivateInputs.hasOwnProperty(key)) {
        obj[key] = oldPrivateInputs[key];
      }
      return obj;
    }, {} as PrivateInputs);

    const selectedPubKeys = ["destinationIdentifier", "commitmentMapperPubKey", "externalNullifier", "nullifier"];
    const publicInputs: PublicInputs = selectedPubKeys.reduce((obj, key) => {
      if (oldPublicInputs.hasOwnProperty(key)) {
        obj[key] = oldPublicInputs[key];
      }
      return obj;
    }, {} as PublicInputs);

    return {
      privateInputs,
      publicInputs,
    };
  }

  public async userParamsValidation({
    source,
    destination,
    claimedValue,
    chainId,
    accountsTree,
    externalNullifier,
    isStrict,
  }: UserParams) {
    source.identifier = BigNumber.from(source.identifier);
    source.secret = BigNumber.from(source.secret);
    destination.identifier = BigNumber.from(destination.identifier);
    destination.secret = BigNumber.from(destination.secret);

    claimedValue = BigNumber.from(claimedValue);
    externalNullifier = BigNumber.from(externalNullifier);
    chainId = BigNumber.from(chainId);

    const zeroPaddedSourceIdentifier = ethers.utils.hexZeroPad(
      source.identifier.toHexString(),
      20
    );

    try {
      this.registryTree.getValue(accountsTree.getRoot().toHexString());
    } catch (e) {
      throw new Error("Accounts tree root not found in the Registry tree");
    }

    const registryHeight = this.registryTree.getHeight();
    if (registryHeight != RegistryTreeHeight)
      throw new Error("Invalid Registry tree height");

    const accountHeight = accountsTree.getHeight();
    if (accountHeight != AddressTreeHeight)
      throw new Error("Invalid Accounts tree height");

    const isSourceCommitmentValid = await verifyCommitment(
      source.identifier,
      source.secret,
      source.commitmentReceipt,
      this.commitmentMapperPubKey
    );
    if (!isSourceCommitmentValid)
      throw new Error("Invalid source commitment receipt");

    const isDestinationCommitmentValid = await verifyCommitment(
      destination.identifier,
      destination.secret,
      destination.commitmentReceipt,
      this.commitmentMapperPubKey
    );
    if (!isDestinationCommitmentValid)
      throw new Error("Invalid destination commitment receipt");

    let sourceValue;
    try {
      sourceValue = accountsTree
        .getValue(zeroPaddedSourceIdentifier)
    } catch (e) {
      throw new Error(
        `Could not find the source ${zeroPaddedSourceIdentifier} in the Accounts tree`
      );
    }

    if (claimedValue.gt(sourceValue)) {
      throw new Error(
        `Claimed value ${claimedValue.toHexString()} can't be superior to Source value`
      );
    }

    if (isStrict && !claimedValue.eq(sourceValue)) {
      throw new Error(
        `Claimed value ${claimedValue.toHexString()} must be equal with Source value when isStrict == 1`
      );
    }

    if (claimedValue.lt(0)) {
      throw new Error(
        `Claimed value ${claimedValue.toHexString()} can't be negative`
      );
    }

    const SnarkField = BigNumber.from(SNARK_FIELD);
    if (externalNullifier.gt(SnarkField)) {
      throw new Error(
        "External nullifier overflow the snark field, please use external nullifier inside the snark field"
      );
    }
    if (source.identifier.gt(SnarkField)) {
      throw new Error(
        "Source identifier overflow the snark field, please use source identifier inside the snark field"
      );
    }
    if (source.secret.gt(SnarkField)) {
      throw new Error(
        "Source secret overflow the snark field, please use source secret inside the snark field"
      );
    }
    if (destination.identifier.gt(SnarkField)) {
      throw new Error(
        "Destination overflow the snark field, please use destination inside the snark field"
      );
    }
    if (destination.secret.gt(SnarkField)) {
      throw new Error(
        "Destination secret overflow the snark field, please use destination secret inside the snark field"
      );
    }
    if (claimedValue.gt(SnarkField)) {
      throw new Error(
        "Claimed value overflow the snark field, please use claimed value inside the snark field"
      );
    }
  }

  public async generateSnarkProofOld({
    source,
    destination,
    claimedValue,
    chainId,
    accountsTree,
    externalNullifier,
    isStrict,
  }: UserParams): Promise<SnarkProof> {
    await this.userParamsValidation({
      source,
      destination,
      claimedValue,
      chainId,
      accountsTree,
      externalNullifier,
      isStrict,
    });

    const { privateInputs, publicInputs } = await this.generateInputs({
      source,
      destination,
      claimedValue,
      chainId,
      accountsTree,
      externalNullifier,
      isStrict,
    });

    const files = {
      wasmPath: "/img/hydra-s1.wasm",
      zkeyPath: "/img/hydra-s1.zkey"
    };

    const { proof, publicSignals } = await groth16.fullProve(
      { ...privateInputs, ...publicInputs },
      files.wasmPath,
      files.zkeyPath,
      console
    );

    return new SnarkProof(publicSignals, proof);
  }

  public async generateSnarkProof({
    source,
    destination,
    claimedValue,
    chainId,
    accountsTree,
    externalNullifier,
    isStrict,
  }: UserParams): Promise<SnarkProof> {

    const { privateInputs, publicInputs } = await this.generateInputs({
      source,
      destination,
      claimedValue,
      chainId,
      accountsTree,
      externalNullifier,
      isStrict,
    });

    const files = {
      wasmPath: "/img/hydra-s1.wasm",
      zkeyPath: "/img/hydra-s1.zkey"
    };

    console.log({groth16})
    const { proof, publicSignals } = await groth16.fullProve(
      { ...privateInputs, ...publicInputs },
      files.wasmPath,
      files.zkeyPath,
      console
    );

    return new SnarkProof(publicSignals, proof);
  }
}
